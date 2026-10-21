import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';

import {
  buildClickScript,
  buildInspectScript,
  buildScrollScript,
  buildSnapshotScript,
  buildTypeScript,
} from './pageActions';

/**
 * These scripts are source text evaluated inside another page: nothing
 * type-checks them, and a value interpolated without escaping either breaks the
 * script or runs as code.
 */
const parses = (source: string): boolean => {
  try {
    new Function(source);
    return true;
  } catch {
    return false;
  }
};

describe('page action scripts', () => {
  test('every script parses', () => {
    expect(parses(buildSnapshotScript())).toBe(true);
    expect(parses(buildSnapshotScript({ selector: '#main' }))).toBe(true);
    expect(parses(buildClickScript({ selector: '#save' }))).toBe(true);
    expect(parses(buildClickScript({ text: 'Save' }))).toBe(true);
    expect(parses(buildTypeScript({ selector: '#q', value: 'hello', submit: true }))).toBe(true);
    expect(parses(buildInspectScript({ selector: '#save' }))).toBe(true);
    expect(parses(buildScrollScript({ direction: 'bottom' }))).toBe(true);
    expect(parses(buildScrollScript({ selector: 'footer' }))).toBe(true);
  });

  test('a hostile selector is embedded as data, not as code', () => {
    const hostile = `'); window.__owned = true; ('`;
    const script = buildClickScript({ selector: hostile });
    expect(parses(script)).toBe(true);
    // Present only inside a quoted literal: that is what makes it inert.
    expect(script).toContain(JSON.stringify(hostile));
  });

  test('a typed value is embedded as data too', () => {
    const value = '"); alert(1); ("';
    const script = buildTypeScript({ selector: '#q', value, submit: false });
    expect(parses(script)).toBe(true);
    expect(script).toContain(JSON.stringify(value));
  });

  test('whitespace regexes survive interpolation', () => {
    // A doubled backslash here would produce a literal backslash-s and match
    // nothing, silently collapsing no whitespace at all.
    expect(buildSnapshotScript()).toContain('replace(/\\s+/g');
  });

  test('scrolling asks for instant behaviour, not the page preference', () => {
    // A page with scroll-behavior: smooth would otherwise still be animating
    // when the position is read.
    expect(buildScrollScript({ direction: 'bottom' })).toContain("behavior: 'instant'");
    expect(buildScrollScript({ selector: 'footer' })).toContain("behavior: 'instant'");
  });

  test('a scoped snapshot reads only the subtree it was given', () => {
    const script = buildSnapshotScript({ selector: '#changelog' });
    expect(script).toContain('"#changelog"');
    expect(script).toContain('root.querySelectorAll');
  });

  test('traverses open and tracked closed shadow roots, clickable rows, and >>> selectors', async () => {
    const win = new Window({ url: 'https://x.com/i/chat' });
    const evaluate = (source: string) => {
      const fn = new Function('window', 'document', 'location', 'CSS', 'requestAnimationFrame', `return ${source}`);
      return fn(
        win,
        win.document,
        win.location,
        win.CSS,
        (cb: FrameRequestCallback) => cb(0),
      );
    };

    try {
      const closedRoots = new WeakMap<object, unknown>();
      (win as unknown as { __openchamberShadowRoots: WeakMap<object, unknown> }).__openchamberShadowRoots = closedRoots;

      const host = win.document.createElement('div');
      host.setAttribute('data-testid', 'xchatEmbedRoute');
      host.getBoundingClientRect = () => ({
        left: 68, top: 0, right: 454, bottom: 691, x: 68, y: 0, width: 386, height: 691, toJSON: () => ({}),
      });
      win.document.body.appendChild(host);

      const shadow = host.attachShadow({ mode: 'closed' });
      closedRoots.set(host, shadow);

      const heading = win.document.createElement('h2');
      heading.textContent = 'Chat';
      heading.getBoundingClientRect = () => ({
        left: 80, top: 12, right: 160, bottom: 40, x: 80, y: 12, width: 80, height: 28, toJSON: () => ({}),
      });
      shadow.appendChild(heading);

      const searchInput = win.document.createElement('input');
      searchInput.setAttribute('placeholder', 'Search');
      searchInput.getBoundingClientRect = () => ({
        left: 80, top: 56, right: 420, bottom: 96, x: 80, y: 56, width: 340, height: 40, toJSON: () => ({}),
      });
      shadow.appendChild(searchInput);

      const row = win.document.createElement('div');
      row.style.cursor = 'pointer';
      row.getBoundingClientRect = () => ({
        left: 80, top: 110, right: 420, bottom: 170, x: 80, y: 110, width: 340, height: 60, toJSON: () => ({}),
      });
      const rowName = win.document.createElement('span');
      rowName.textContent = 'Bryla Kellam';
      const rowPreview = win.document.createElement('span');
      rowPreview.textContent = 'how are you?';
      row.append(rowName, rowPreview);
      shadow.appendChild(row);

      let rowClicked = 0;
      row.addEventListener('click', () => { rowClicked += 1; });

      const snap = evaluate(buildSnapshotScript()) as {
        ok: boolean;
        text: string;
        elements: Array<{ selector: string; tag: string; label?: string }>;
      };
      expect(snap.ok).toBe(true);
      expect(snap.text).toContain('Chat');
      expect(snap.text).toContain('Bryla Kellam');
      expect(snap.text).toContain('how are you?');

      const searchEntry = snap.elements.find((e) => e.tag === 'input');
      expect(searchEntry?.selector).toBe('div[data-testid="xchatEmbedRoute"] >>> input[placeholder="Search"]');

      const rowEntry = snap.elements.find((e) => e.label?.includes('Bryla Kellam'));
      expect(rowEntry).toBeDefined();
      expect(rowEntry?.selector).toContain('div[data-testid="xchatEmbedRoute"] >>>');

      const typed = evaluate(buildTypeScript({
        selector: searchEntry!.selector,
        value: 'Jaime',
        submit: false,
      })) as { ok: boolean };
      expect(typed.ok).toBe(true);
      expect(searchInput.value).toBe('Jaime');

      const clickedByText = evaluate(buildClickScript({ text: 'Bryla Kellam' })) as { ok: boolean; clicked: string };
      expect(clickedByText.ok).toBe(true);
      expect(rowClicked).toBe(1);

      const inspected = evaluate(buildInspectScript({ selector: searchEntry!.selector })) as {
        ok: boolean;
        tag: string;
      };
      expect(inspected.ok).toBe(true);
      expect(inspected.tag).toBe('input');
    } finally {
      await win.happyDOM.close();
    }
  });

  test('scrolls an inner scrollable pane when the document itself does not scroll', async () => {
    const win = new Window({ url: 'https://x.com/i/chat' });
    const evaluate = (source: string) => {
      const fn = new Function('window', 'document', 'location', 'CSS', 'requestAnimationFrame', `return ${source}`);
      return fn(
        win,
        win.document,
        win.location,
        win.CSS,
        (cb: FrameRequestCallback) => cb(0),
      );
    };

    try {
      Object.defineProperty(win, 'innerHeight', { value: 700, configurable: true });
      Object.defineProperty(win.document.documentElement, 'scrollHeight', { value: 700, configurable: true });

      const host = win.document.createElement('div');
      host.setAttribute('data-testid', 'xchatEmbedRoute');
      win.document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });

      const pane = win.document.createElement('div');
      pane.style.overflowY = 'auto';
      pane.getBoundingClientRect = () => ({
        left: 68, top: 0, right: 454, bottom: 700, x: 68, y: 0, width: 386, height: 700, toJSON: () => ({}),
      });
      Object.defineProperty(pane, 'clientHeight', { value: 700, configurable: true });
      Object.defineProperty(pane, 'scrollHeight', { value: 2100, configurable: true });
      pane.scrollTop = 0;
      shadow.appendChild(pane);

      const scrolled = await (evaluate(buildScrollScript({ direction: 'down' })) as Promise<{
        ok: boolean;
        scrollY: number;
        maxScrollY: number;
        atTop: boolean;
      }>);
      expect(scrolled.ok).toBe(true);
      expect(scrolled.maxScrollY).toBe(1400);
      expect(scrolled.scrollY).toBe(595);
      expect(scrolled.atTop).toBe(false);
    } finally {
      await win.happyDOM.close();
    }
  });
});
