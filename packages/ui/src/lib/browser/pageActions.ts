/**
 * Scripts the agent's browser actions run inside the page.
 *
 * Each builder returns a self-contained expression evaluated in the page's own
 * context, so none of them may reference anything from this module at runtime.
 * Inputs are embedded with `JSON.stringify`, which is what keeps a selector or
 * a typed value from terminating the expression and becoming code.
 *
 * Every script resolves to `{ ok, ... }` instead of throwing, so a failed match
 * comes back as an explainable result rather than an opaque evaluation error.
 */

/**
 * Budget caps. The snapshot cost is bounded by these, not by the size of the
 * page: a document with ten thousand nodes returns the same shape as one with
 * two hundred, because only visible interactive elements are collected and both
 * lists are cut off here. What the caps drop is always reported, so a partial
 * answer never reads as a complete one.
 */
const MAX_TEXT_CHARS = 6_000;
const MAX_ELEMENTS = 120;
/** Enough to recognise a control; full labels are what made entries expensive. */
const MAX_LABEL_CHARS = 80;

/**
 * Shared helpers, injected into each script. `describe` builds the same kind of
 * selector the other actions accept, so a snapshot result is directly usable as
 * input to click or type.
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="listitem"]',
  '[role="row"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const HELPERS = `
  var MAX_ELEMENTS = ${MAX_ELEMENTS};
  var MAX_LABEL_CHARS = ${MAX_LABEL_CHARS};
  var INTERACTIVE_SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};

  var viewOf = function (node) {
    var doc = node && (node.nodeType === 9 ? node : node.ownerDocument);
    return (doc && doc.defaultView) || window;
  };

  var cssEscape = function (value) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
      return CSS.escape(String(value));
    }
    return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
  };

  var getShadow = function (element) {
    if (!element || element.nodeType !== 1) return null;
    if (element.hasAttribute && element.hasAttribute('data-openchamber-annotation')) return null;
    if (element.shadowRoot) return element.shadowRoot;
    try {
      var win = viewOf(element);
      var map = win && win.__openchamberShadowRoots;
      if (map && typeof map.get === 'function') return map.get(element) || null;
    } catch (error) {}
    return null;
  };

  var getFrameDoc = function (element) {
    if (!element || element.nodeType !== 1) return null;
    var tag = element.tagName;
    if (tag !== 'IFRAME' && tag !== 'FRAME') return null;
    try {
      var doc = element.contentDocument;
      if (doc && doc.documentElement) return doc;
    } catch (error) {}
    return null;
  };

  var boundsOf = function (element) {
    var rect = element.getBoundingClientRect();
    var x = rect.x !== undefined ? rect.x : rect.left;
    var y = rect.y !== undefined ? rect.y : rect.top;
    var win = viewOf(element);
    while (win && win.frameElement) {
      var frameRect = win.frameElement.getBoundingClientRect();
      x += frameRect.x !== undefined ? frameRect.x : frameRect.left;
      y += frameRect.y !== undefined ? frameRect.y : frameRect.top;
      win = viewOf(win.frameElement);
    }
    return {
      x: x,
      y: y,
      top: y,
      bottom: y + rect.height,
      width: rect.width,
      height: rect.height
    };
  };

  var visible = function (element) {
    if (!element || element.nodeType !== 1) return false;
    var rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    var style = viewOf(element).getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };

  var readNodeText = function (node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return '';
    if (node.nodeType === 1) {
      var tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG') return '';
      if (node.hasAttribute && node.hasAttribute('data-openchamber-annotation')) return '';
      var style = viewOf(node).getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return '';
    }
    var shadow = node.nodeType === 1 ? getShadow(node) : null;
    if (shadow) return readNodeText(shadow);
    var frameDoc = node.nodeType === 1 ? getFrameDoc(node) : null;
    if (frameDoc && frameDoc.body) return readNodeText(frameDoc.body);
    if (node.nodeType === 1 && node.tagName === 'SLOT' && typeof node.assignedNodes === 'function') {
      var assigned = node.assignedNodes({ flatten: true });
      if (assigned && assigned.length > 0) {
        var slotParts = [];
        for (var s = 0; s < assigned.length; s += 1) {
          var st = readNodeText(assigned[s]);
          if (st) slotParts.push(st);
        }
        return slotParts.join(' ');
      }
    }
    var children = node.childNodes;
    if (!children || children.length === 0) {
      return node.nodeType === 1 ? (node.innerText || node.textContent || '') : '';
    }
    var parts = [];
    for (var i = 0; i < children.length; i += 1) {
      var child = children[i];
      if (child.nodeType === 3) {
        var raw = (child.nodeValue || '').replace(/\\s+/g, ' ');
        if (raw.trim()) parts.push(raw);
      } else if (child.nodeType === 1) {
        var childText = readNodeText(child);
        if (childText && childText.trim()) {
          var display = viewOf(child).getComputedStyle(child).display || '';
          var isInline = display.indexOf('inline') === 0 || display === 'contents';
          parts.push(isInline ? childText.trim() : '\\n' + childText.trim() + '\\n');
        }
      }
    }
    return parts.join(' ');
  };

  var label = function (element) {
    var aria = element.getAttribute('aria-label');
    if (aria) return aria.trim();
    var value = element.getAttribute('value');
    var text = (element.innerText || element.textContent || readNodeText(element) || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, MAX_LABEL_CHARS);
    if (value) return String(value).slice(0, MAX_LABEL_CHARS);
    var placeholder = element.getAttribute('placeholder');
    return placeholder ? placeholder.trim().slice(0, MAX_LABEL_CHARS) : '';
  };

  /**
   * Collects every queryable root (Document, ShadowRoot, or scoped Element)
   * reachable from startRoot, in pre-order traversal.
   */
  var collectRoots = function (startRoot) {
    var roots = [];
    var seen = [];
    var visitRoot = function (root) {
      if (!root || seen.indexOf(root) !== -1) return;
      seen.push(root);
      if (typeof root.querySelectorAll === 'function') roots.push(root);
      if (root.nodeType === 1) {
        var ownShadow = getShadow(root);
        if (ownShadow) visitRoot(ownShadow);
        var ownFrame = getFrameDoc(root);
        if (ownFrame) visitRoot(ownFrame);
      }
      if (typeof root.querySelectorAll !== 'function') return;
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i += 1) {
        var el = all[i];
        var shadow = getShadow(el);
        if (shadow) visitRoot(shadow);
        var frameDoc = getFrameDoc(el);
        if (frameDoc) visitRoot(frameDoc);
      }
    };
    visitRoot(startRoot || document);
    return roots;
  };

  var splitPiercing = function (selector) {
    var parts = [];
    var current = '';
    var quote = '';
    var s = String(selector || '');
    for (var i = 0; i < s.length; i += 1) {
      var ch = s.charAt(i);
      if (quote) {
        current += ch;
        if (ch === quote && s.charAt(i - 1) !== '\\\\') quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === '>' && s.slice(i, i + 3) === '>>>') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i += 2;
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  };

  var queryAllInScope = function (scopeRoot, selector) {
    var roots = collectRoots(scopeRoot);
    var out = [];
    for (var r = 0; r < roots.length; r += 1) {
      var matches = roots[r].querySelectorAll(selector);
      for (var m = 0; m < matches.length; m += 1) {
        if (out.indexOf(matches[m]) === -1) out.push(matches[m]);
      }
    }
    return out;
  };

  var queryAllDeep = function (startRoot, selector) {
    var segments = splitPiercing(selector);
    if (segments.length === 0) return [];
    var currentScopes = [startRoot || document];
    for (var s = 0; s < segments.length; s += 1) {
      var seg = segments[s];
      var nextMatches = [];
      for (var c = 0; c < currentScopes.length; c += 1) {
        var scope = currentScopes[c];
        var searchRoot = scope;
        if (s > 0 && scope && scope.nodeType === 1) {
          searchRoot = getShadow(scope) || getFrameDoc(scope) || scope;
        }
        var found = queryAllInScope(searchRoot, seg);
        for (var f = 0; f < found.length; f += 1) {
          if (nextMatches.indexOf(found[f]) === -1) nextMatches.push(found[f]);
        }
      }
      currentScopes = nextMatches;
      if (currentScopes.length === 0) return [];
    }
    return currentScopes;
  };

  var queryDeep = function (startRoot, selector) {
    var matches = queryAllDeep(startRoot, selector);
    return matches.length > 0 ? matches[0] : null;
  };

  var isUniqueInRoot = function (queryRoot, selector) {
    try {
      return queryRoot.querySelectorAll(selector).length === 1;
    } catch (error) {
      return false;
    }
  };

  /**
   * Names an element by what it is, falling back to where it sits.
   *
   * When the element lives inside a shadow root or same-origin iframe, each
   * boundary is joined with ' >>> ' so the resulting selector can step back
   * through the same hosts deterministically.
   */
  var localCssPath = function (element, queryRoot) {
    var tag = element.tagName.toLowerCase();

    if (element.id) {
      var byId = '#' + cssEscape(element.id);
      if (isUniqueInRoot(queryRoot, byId)) return byId;
    }
    var stableAttrs = ['data-testid', 'data-test-id', 'data-test', 'name', 'aria-label', 'placeholder'];
    for (var a = 0; a < stableAttrs.length; a += 1) {
      var value = element.getAttribute(stableAttrs[a]);
      if (!value) continue;
      var raw = String(value);
      if (raw.indexOf('"') !== -1 || raw.indexOf('\\n') !== -1) continue;
      var byAttr = tag + '[' + stableAttrs[a] + '="' + raw + '"]';
      if (isUniqueInRoot(queryRoot, byAttr)) return byAttr;
    }
    var className = typeof element.className === 'string' ? element.className.trim() : '';
    if (className) {
      var classes = className.split(/\\s+/).filter(Boolean);
      for (var c = 0; c < classes.length; c += 1) {
        var byClass = tag + '.' + cssEscape(classes[c]);
        if (isUniqueInRoot(queryRoot, byClass)) return byClass;
      }
    }

    var parts = [];
    var node = element;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== queryRoot && depth < 6) {
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) {
        if (queryRoot && queryRoot.children) {
          var rootSiblings = Array.prototype.filter.call(queryRoot.children, function (child) {
            return child.tagName === node.tagName;
          });
          if (rootSiblings.length > 1) part += ':nth-of-type(' + (rootSiblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        break;
      }
      var siblings = Array.prototype.filter.call(parent.children, function (child) {
        return child.tagName === node.tagName;
      });
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part);
      if (node.id) {
        var idSelector = '#' + cssEscape(node.id);
        if (isUniqueInRoot(queryRoot, idSelector)) { parts[0] = idSelector; break; }
      }
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  };

  var cssPath = function (element) {
    var rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : element.ownerDocument || document;
    var queryRoot = (rootNode && typeof rootNode.querySelectorAll === 'function') ? rootNode : (element.ownerDocument || document);
    var local = localCssPath(element, queryRoot);
    if (rootNode && rootNode.host) {
      return cssPath(rootNode.host) + ' >>> ' + local;
    }
    var win = element.ownerDocument && element.ownerDocument.defaultView;
    if (win && win.frameElement) {
      return cssPath(win.frameElement) + ' >>> ' + local;
    }
    return local;
  };

  /** What a screen reader would announce, or '' when there is nothing to say. */
  var accessibleName = function (element) {
    var aria = element.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    var labelled = element.getAttribute('aria-labelledby');
    if (labelled) {
      var rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : document;
      var labelId = labelled.split(/\\s+/)[0];
      var source = (rootNode && typeof rootNode.getElementById === 'function' ? rootNode.getElementById(labelId) : null) || document.getElementById(labelId);
      if (source && (source.innerText || source.textContent || '').trim()) return (source.innerText || source.textContent || '').trim();
    }
    var title = element.getAttribute('title');
    if (title && title.trim()) return title.trim();
    var alt = element.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    var text = (element.innerText || element.textContent || readNodeText(element) || '').replace(/\\s+/g, ' ').trim();
    if (text) return text;
    var value = element.getAttribute('value');
    if (value && String(value).trim()) return String(value).trim();
    var placeholder = element.getAttribute('placeholder');
    return placeholder && placeholder.trim() ? placeholder.trim() : '';
  };

  var collectInteractiveElements = function (scopeRoot) {
    var roots = collectRoots(scopeRoot);
    var matched = [];
    for (var r = 0; r < roots.length; r += 1) {
      var currentRoot = roots[r];
      var explicit = currentRoot.querySelectorAll(INTERACTIVE_SELECTOR);
      for (var i = 0; i < explicit.length; i += 1) {
        if (matched.indexOf(explicit[i]) === -1) matched.push(explicit[i]);
      }
      // Many modern list UIs (such as chat conversation rows) attach click
      // handlers to plain divs with cursor:pointer and no ARIA role. Include
      // only the topmost pointer boundary so child spans/icons are not
      // repeated as separate controls.
      var all = currentRoot.querySelectorAll('*');
      for (var a = 0; a < all.length; a += 1) {
        var el = all[a];
        if (matched.indexOf(el) !== -1) continue;
        if (!visible(el)) continue;
        var style = viewOf(el).getComputedStyle(el);
        if (style.cursor !== 'pointer') continue;
        var parent = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
        if (parent && parent.nodeType === 1 && viewOf(parent).getComputedStyle(parent).cursor === 'pointer') continue;
        var rect = el.getBoundingClientRect();
        if (rect.height > window.innerHeight * 0.75) continue;
        if (!label(el)) continue;
        matched.push(el);
      }
    }
    return matched;
  };

  var findByText = function (needle) {
    var wanted = String(needle).replace(/\\s+/g, ' ').trim().toLowerCase();
    var candidates = collectInteractiveElements(document);
    var exact = null;
    var partial = null;
    for (var i = 0; i < candidates.length; i += 1) {
      var element = candidates[i];
      if (!visible(element)) continue;
      var text = label(element).toLowerCase();
      if (!text) continue;
      if (text === wanted) { exact = element; break; }
      if (!partial && text.indexOf(wanted) !== -1) partial = element;
    }
    return exact || partial;
  };

  var findScrollableContainer = function (scopeRoot) {
    var doc = document.documentElement;
    if ((!scopeRoot || scopeRoot === document) && doc && (doc.scrollHeight - window.innerHeight > 1)) {
      return null;
    }
    if (scopeRoot && scopeRoot.nodeType === 1) {
      var ownStyle = viewOf(scopeRoot).getComputedStyle(scopeRoot);
      if (/(auto|scroll|overlay)/.test(ownStyle.overflowY) && scopeRoot.scrollHeight > scopeRoot.clientHeight + 1) {
        return scopeRoot;
      }
    }
    var roots = collectRoots(scopeRoot || document);
    var best = null;
    var bestArea = 0;
    for (var r = 0; r < roots.length; r += 1) {
      var all = roots[r].querySelectorAll('*');
      for (var i = 0; i < all.length; i += 1) {
        var el = all[i];
        if (!visible(el)) continue;
        if (el.scrollHeight <= el.clientHeight + 1) continue;
        var style = viewOf(el).getComputedStyle(el);
        if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;
        var rect = el.getBoundingClientRect();
        var area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
    }
    return best;
  };

  var readScrollMetrics = function (scopeRoot) {
    var container = findScrollableContainer(scopeRoot);
    if (container) {
      return {
        container: container,
        scrollY: Math.round(container.scrollTop),
        maxScrollY: Math.max(0, Math.round(container.scrollHeight - container.clientHeight))
      };
    }
    var docEl = document.documentElement;
    return {
      container: null,
      scrollY: Math.round(window.scrollY),
      maxScrollY: Math.max(0, Math.round((docEl ? docEl.scrollHeight : 0) - window.innerHeight))
    };
  };
`;

const wrap = (body: string): string => `(() => {\n${HELPERS}\n${body}\n})()`;

/**
 * `selector` narrows the snapshot to one subtree.
 *
 * A long page truncates against the caps no matter how they are tuned, which
 * leaves the agent hunting. Scoping answers that directly: ask about the part
 * you mean and the caps stop mattering.
 */
export const buildSnapshotScript = ({ selector }: { selector?: string } = {}): string => wrap(`
  var scopeSelector = ${JSON.stringify(selector ?? '')};
  var root = document;
  if (scopeSelector) {
    try { root = queryDeep(document, scopeSelector); }
    catch (error) { return { ok: false, error: 'Invalid selector: ' + scopeSelector }; }
    if (!root) return { ok: false, error: 'No element matches ' + scopeSelector };
  }
  var interactive = collectInteractiveElements(root);
  var elements = [];
  var visibleTotal = 0;
  for (var i = 0; i < interactive.length; i += 1) {
    var element = interactive[i];
    if (!visible(element)) continue;
    visibleTotal += 1;
    if (elements.length >= MAX_ELEMENTS) continue;

    var rect = boundsOf(element);
    // Empty and default-valued fields are left out rather than serialized as
    // "" and false. Repeated across a hundred entries that overhead dwarfed
    // the information it carried.
    var entry = {
      selector: cssPath(element),
      tag: element.tagName.toLowerCase(),
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
    // The list covers the whole document so anything can be clicked without
    // scrolling to it first, which means bounds alone do not say what is on
    // screen — a negative y reads as a bug otherwise.
    if (rect.bottom > 0 && rect.top < window.innerHeight) entry.inViewport = true;
    var type = element.getAttribute('type');
    if (type) entry.type = type;
    var role = element.getAttribute('role');
    if (role) entry.role = role;
    var labelText = label(element);
    if (labelText) entry.label = labelText;
    if (element.disabled === true) entry.disabled = true;
    // Flagged rather than described: reporting the accessible name of every
    // element would cost more than it tells, while its absence on something
    // clickable is a defect worth naming.
    if (!accessibleName(element)) entry.missingAccessibleName = true;
    elements.push(entry);
  }
  var textRoot = root === document ? (document.body || document.documentElement) : root;
  var rootsInScope = textRoot ? collectRoots(textRoot) : [];
  var rawText = '';
  if (textRoot) {
    if (rootsInScope.length <= 1 && textRoot.innerText) {
      rawText = textRoot.innerText;
    } else {
      rawText = readNodeText(textRoot);
    }
  }
  var text = rawText.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n[ \\t]+/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  var scrollMetrics = readScrollMetrics(root);
  var result = {
    ok: true,
    url: String(location.href),
    title: String(document.title || ''),
    scope: scopeSelector || 'document',
    scrollY: scrollMetrics.scrollY,
    maxScrollY: scrollMetrics.maxScrollY,
    text: text.slice(0, ${MAX_TEXT_CHARS}),
    elements: elements
  };
  // State what was dropped. A capped list that reports only its own length
  // reads as the whole page, and the agent acts as if it had seen everything.
  if (text.length > ${MAX_TEXT_CHARS}) {
    result.textTruncated = true;
    result.textTotalChars = text.length;
  }
  if (visibleTotal > elements.length) {
    result.elementsTruncated = true;
    result.interactiveElementsOnPage = visibleTotal;
  }
  return result;
`);

export const buildClickScript = ({ selector, text }: { selector?: string; text?: string }): string => wrap(`
  var selector = ${JSON.stringify(selector ?? '')};
  var text = ${JSON.stringify(text ?? '')};
  var target = null;
  if (selector) {
    try { target = queryDeep(document, selector); }
    catch (error) { return { ok: false, error: 'Invalid selector: ' + selector }; }
    if (!target) return { ok: false, error: 'No element matches ' + selector };
  } else {
    target = findByText(text);
    if (!target) return { ok: false, error: 'No clickable element has the label ' + text };
  }
  if (target.disabled === true) return { ok: false, error: 'Element is disabled' };
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center', inline: 'center' });
  }
  if (typeof target.click === 'function') {
    target.click();
  } else {
    var win = viewOf(target);
    target.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
  }
  return { ok: true, clicked: cssPath(target), label: label(target), url: String(location.href) };
`);

export const buildTypeScript = ({ selector, value, submit }: { selector: string; value: string; submit: boolean }): string => wrap(`
  var selector = ${JSON.stringify(selector)};
  var value = ${JSON.stringify(value)};
  var target = null;
  try { target = queryDeep(document, selector); }
  catch (error) { return { ok: false, error: 'Invalid selector: ' + selector }; }
  if (!target) return { ok: false, error: 'No element matches ' + selector };

  var role = target.getAttribute && target.getAttribute('role');
  var editable = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.getAttribute('contenteditable') === 'true' || role === 'textbox' || role === 'searchbox';
  if (!editable) return { ok: false, error: selector + ' is not a text field' };
  if (target.disabled === true || target.readOnly === true) return { ok: false, error: 'Field is not editable' };

  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center' });
  }
  if (typeof target.focus === 'function') {
    target.focus();
  }
  var win = viewOf(target);
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true' || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA')) {
    var doc = target.ownerDocument || document;
    var inserted = false;
    try {
      if (typeof doc.execCommand === 'function') {
        doc.execCommand('selectAll', false, null);
        inserted = doc.execCommand('insertText', false, value);
      }
    } catch (error) { inserted = false; }
    if (!inserted || (target.textContent || '') !== value) {
      target.textContent = value;
    }
  } else {
    // Frameworks track the value through the native setter; assigning the
    // property directly leaves React and friends unaware of the change.
    var prototype = target.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (setter && setter.set) setter.set.call(target, value);
    else target.value = value;
  }
  target.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
  target.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));

  if (${submit ? 'true' : 'false'}) {
    var enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true };
    target.dispatchEvent(new win.KeyboardEvent('keydown', enter));
    target.dispatchEvent(new win.KeyboardEvent('keyup', enter));
    var form = target.form;
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
  }
  return { ok: true, selector: cssPath(target), url: String(location.href) };
`);

/**
 * Scrolling, reported after it has actually happened.
 *
 * Two things made this lie. Pages commonly set `scroll-behavior: smooth`, which
 * turns a programmatic scroll into an animation — so the position read straight
 * afterwards is the position before the scroll, and the result said nothing
 * moved. And a scroll that is already at the end is indistinguishable from one
 * that failed unless the limits are reported too. An agent reading "scrollY: 0"
 * from a scroll that worked learns a superstition it will apply for the rest of
 * the session.
 */
export const buildScrollScript = ({ selector, direction }: { selector?: string; direction?: string }): string => wrap(`
  var selector = ${JSON.stringify(selector ?? '')};
  var direction = ${JSON.stringify(direction ?? '')};

  var settle = function (scrollRoot, extra) {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var metrics = readScrollMetrics(scrollRoot);
          var scrollY = metrics.scrollY;
          var maxScrollY = metrics.maxScrollY;
          var result = { ok: true, scrollY: scrollY, maxScrollY: maxScrollY };
          result.atTop = scrollY <= 1;
          result.atBottom = scrollY >= maxScrollY - 1;
          for (var key in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, key)) result[key] = extra[key];
          }
          resolve(result);
        });
      });
    });
  };

  var scrollContainerInDirection = function (container, dir) {
    if (container) {
      var page = Math.round(container.clientHeight * 0.85);
      var bottom = Math.max(0, container.scrollHeight - container.clientHeight);
      var nextTop = container.scrollTop;
      if (dir === 'down') nextTop = Math.min(bottom, container.scrollTop + page);
      else if (dir === 'up') nextTop = Math.max(0, container.scrollTop - page);
      else if (dir === 'top') nextTop = 0;
      else if (dir === 'bottom') nextTop = bottom;
      else return false;
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: nextTop, behavior: 'instant' });
      } else {
        container.scrollTop = nextTop;
      }
      return true;
    }
    var doc = document.documentElement;
    var winPage = Math.round(window.innerHeight * 0.85);
    var winBottom = Math.max(0, (doc ? doc.scrollHeight : 0) - window.innerHeight);
    if (dir === 'down') window.scrollTo({ top: window.scrollY + winPage, behavior: 'instant' });
    else if (dir === 'up') window.scrollTo({ top: window.scrollY - winPage, behavior: 'instant' });
    else if (dir === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
    else if (dir === 'bottom') window.scrollTo({ top: winBottom, behavior: 'instant' });
    else return false;
    return true;
  };

  if (selector) {
    var target = null;
    try { target = queryDeep(document, selector); }
    catch (error) { return { ok: false, error: 'Invalid selector: ' + selector }; }
    if (!target) return { ok: false, error: 'No element matches ' + selector };
    if (direction) {
      var scopedContainer = findScrollableContainer(target);
      if (!scopedContainer && target.scrollHeight > target.clientHeight + 1) scopedContainer = target;
      if (!scrollContainerInDirection(scopedContainer, direction)) {
        return { ok: false, error: 'Unknown scroll direction: ' + direction };
      }
      return settle(scopedContainer || target, { direction: direction, scrolledTo: cssPath(target) });
    }
    // Instant on purpose: the page's own smooth scrolling would still be
    // animating when the next action runs against it.
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    return settle(document, { scrolledTo: cssPath(target) });
  }

  var activeContainer = findScrollableContainer(document);
  if (!scrollContainerInDirection(activeContainer, direction)) {
    return { ok: false, error: 'Unknown scroll direction: ' + direction };
  }
  return settle(activeContainer || document, { direction: direction });
`);

/** Properties that answer "how does this look", without dumping the whole cascade. */
const INSPECTED_STYLE_PROPS = [
  'color', 'background-color', 'background-image', 'opacity',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
  'border-radius', 'border-width', 'border-style', 'border-color', 'box-shadow',
  'display', 'position', 'width', 'height', 'padding', 'margin', 'gap',
  'flex-direction', 'justify-content', 'align-items', 'z-index', 'overflow', 'visibility',
];

/**
 * Reads how one element actually renders.
 *
 * The snapshot describes structure, which leaves questions of appearance
 * answerable only by reading the source and hoping the build agrees. Computed
 * styles come from the live page, so a colour reported from here is the colour
 * on screen — and unlike a screenshot it is readable by an agent that cannot
 * see images.
 */
export const buildInspectScript = ({ selector }: { selector: string }): string => wrap(`
  var selector = ${JSON.stringify(selector)};
  var target = null;
  try { target = queryDeep(document, selector); }
  catch (error) { return { ok: false, error: 'Invalid selector: ' + selector }; }
  if (!target) return { ok: false, error: 'No element matches ' + selector };

  var computed = viewOf(target).getComputedStyle(target);
  var styles = {};
  var props = ${JSON.stringify(INSPECTED_STYLE_PROPS)};
  for (var i = 0; i < props.length; i += 1) {
    var value = computed.getPropertyValue(props[i]);
    if (value) styles[props[i]] = String(value).trim();
  }

  var rect = boundsOf(target);
  return {
    ok: true,
    selector: cssPath(target),
    tag: target.tagName.toLowerCase(),
    label: label(target),
    bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    inViewport: rect.bottom > 0 && rect.top < window.innerHeight,
    styles: styles
  };
`);
