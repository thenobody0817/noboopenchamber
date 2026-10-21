import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLAnchorElement: dom.HTMLAnchorElement,
});

const { decorateMarkdown } = await import('./decorate');

const context = (render: (source: string) => string | null) => ({
  labels: {
    copy: 'Copy', copied: 'Copied', enableCodeWrap: 'Wrap', disableCodeWrap: 'Unwrap',
    copyTable: 'Copy table', downloadTable: 'Download table', copyDiagram: 'Copy diagram',
    downloadDiagram: 'Download diagram', zoomInDiagram: 'Zoom in', zoomOutDiagram: 'Zoom out',
    resetDiagramView: 'Reset', previewLabel: 'Preview', previewTitle: 'Preview',
  },
  mermaidControls: { download: true, copy: true, showPanZoomControls: false },
  codeBlockLineWrap: false,
  renderMermaid: () => ({}),
  renderChart: render,
});

const render = (root: HTMLElement, renderChart: (source: string) => string | null): void => {
  document.body.append(root);
  decorateMarkdown(root, context(renderChart));
};

afterEach(() => document.body.replaceChildren());
afterAll(() => dom.happyDOM.close());

const chartFence = (body: string): HTMLElement => {
  const root = document.createElement('div');
  root.innerHTML = `<pre><code class="language-chart">${body}</code></pre>`;
  return root;
};

test('a chart fence becomes a chart block with copy and download controls', () => {
  const root = chartFence('{&quot;type&quot;:&quot;line&quot;}');
  render(root, () => '<svg viewBox="0 0 640 200"></svg>');

  const block = root.querySelector('[data-markdown="chart-block"]');
  expect(block).not.toBeNull();
  expect(root.querySelector('pre > code.language-chart')).toBeNull();
  expect(block?.querySelector('svg')).not.toBeNull();
  expect(root.querySelector('[data-md-action="chart-copy"]')).not.toBeNull();
  expect(root.querySelector('[data-md-action="chart-download"]')).not.toBeNull();
  // The saved file must be the rendered chart, not the spec.
  expect(block?.querySelector('[data-markdown="chart-svg"]')?.getAttribute('data-md-original-svg'))
    .toBe('<svg viewBox="0 0 640 200"></svg>');
});

test('an unusable spec keeps the fence as a code block, with no chart card', () => {
  const root = chartFence('{&quot;type&quot;:&quot;line&quot;,&quot;series&quot;');
  render(root, () => null);

  expect(root.querySelector('[data-markdown="chart-block"]')).toBeNull();
  expect(root.querySelector('pre > code.language-chart')?.textContent).toBe('{"type":"line","series"');
  // No code-block chrome either: the fence is still a candidate to become a chart.
  expect(root.querySelector('[data-component="markdown-code"]')).toBeNull();
});

test('without a renderer the fence is left completely alone', () => {
  const root = chartFence('{}');
  document.body.append(root);
  decorateMarkdown(root, { ...context(() => null), renderChart: undefined });

  expect(root.querySelector('[data-markdown="chart-block"]')).toBeNull();
  expect(root.querySelector('pre > code.language-chart')).not.toBeNull();
});