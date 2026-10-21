import { expect, test } from 'bun:test';
import { parseChartSpec } from './chartSpec';
import { renderChartSvg, type ChartColors } from './chartSvg';

const colors: ChartColors = {
  fg: '#1b1b1f',
  muted: '#6b6b76',
  line: '#d8d8e0',
  accent: '#7c5cff',
  surface: '#f2f2f7',
  positive: '#2e7d4f',
  negative: '#c0392b',
};

const render = (spec: unknown): string => {
  const parsed = parseChartSpec(JSON.stringify(spec));
  if (!parsed) throw new Error('spec should parse');
  return renderChartSvg(parsed, colors);
};

test('a line chart draws one polyline per series over a grid', () => {
  const svg = render({
    type: 'line',
    title: 'Loss',
    x: ['1k', '2k', '3k'],
    series: [{ name: 'healthy', values: [2, 1.2, 0.8] }, { name: 'diverging', values: [2, 2.6, 4.1] }],
  });

  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg).toContain('viewBox="0 0 640');
  expect(svg).toContain('role="img"');
  expect(svg).toContain('aria-label="Loss"');
  expect(svg.match(/<polyline /g)?.length).toBe(2);
  expect(svg).toContain('>Loss</text>');
  expect(svg).toContain('>1k</text>');
  expect(svg).toContain('>healthy</text>');
  expect(svg).not.toContain('NaN');
});

test('a bar chart draws one bar per value and labels small sets', () => {
  const svg = render({ type: 'bar', series: [{ name: 'hits', values: [3, -2, 5] }] });

  // The legend swatch is a rect too; bars are the rounded-corner ones.
  expect(svg.match(/<rect[^>]*rx="2"/g)?.length).toBe(3);
  expect(svg).toContain('>-2</text>');
  expect(svg).not.toContain('NaN');
});

test('a negative bar hangs below the zero baseline', () => {
  const svg = render({ type: 'bar', series: [{ values: [2, -1] }] });
  const bars = Array.from(svg.matchAll(/<rect[^>]*y="([-\d.]+)"[^>]*height="([\d.]+)"/g), (match) => ({
    y: Number(match[1]),
    height: Number(match[2]),
  }));

  expect(bars.length).toBe(2);
  const [positive, negative] = bars;
  // Below the axis, and shorter than the bar twice its size.
  expect(negative?.y).toBeGreaterThan(positive?.y ?? 0);
  expect(negative?.height).toBeCloseTo((positive?.height ?? 0) / 2, 1);
});

test('a large series drops point markers and thins the x labels', () => {
  const values = Array.from({ length: 120 }, (_, index) => index);
  const svg = render({ type: 'line', x: values.map((_, index) => `p${index}`), series: [{ name: 'a', values }] });

  expect(svg).not.toContain('<circle');
  // 120 categories cannot all be labelled at chat text size.
  expect(svg.match(/>p\d+<\/text>/g)?.length ?? 0).toBeLessThanOrEqual(9);
  expect(svg).toContain('>p0</text>');
  expect(svg).toContain('>p119</text>');
});

test('a sparkline is one line with an area fill and no axes', () => {
  const svg = render({ type: 'sparkline', series: [{ name: 'cpu', values: [10, 40, 20, 60] }] });

  expect(svg.match(/<polyline /g)?.length).toBe(1);
  expect(svg).toContain('<path');
  expect(svg).toContain('fill-opacity="0.12"');
  expect(svg).not.toContain('>cpu</text>');
});

test('kpi tiles render label, value and a signed delta', () => {
  const svg = render({
    type: 'kpi',
    title: 'Today',
    tiles: [{ label: 'Requests', value: '1284', delta: '+12%' }, { label: 'Errors', value: '7', delta: '-3%' }],
  });

  expect(svg).toContain('>Requests</text>');
  expect(svg).toContain('>1284</text>');
  expect(svg).toContain(`fill="${colors.positive}"`);
  expect(svg).toContain(`fill="${colors.negative}"`);
  expect(svg.match(/<rect /g)?.length).toBe(2);
});

test('six kpi tiles shrink their values to fit the tile', () => {
  const svg = render({
    type: 'kpi',
    tiles: Array.from({ length: 6 }, (_, index) => ({ label: `metric ${index}`, value: '1234567890' })),
  });

  // 640px across six tiles leaves no room for a 26px value.
  expect(svg).not.toContain('font-size="26"');
  expect(svg).toContain('…</text>');
});

test('one wide tile keeps a full-size value', () => {
  const svg = render({ type: 'kpi', tiles: [{ label: 'Requests', value: '1284' }] });

  expect(svg).toContain('font-size="26"');
  expect(svg).not.toContain('…</text>');
});

test('a flat series still gets a readable range', () => {
  const svg = render({ type: 'line', series: [{ name: 'a', values: [5, 5, 5] }] });

  expect(svg).not.toContain('NaN');
  expect(svg).toContain('<polyline');
});

test('labels and titles are escaped, so a spec cannot inject markup', () => {
  const svg = render({
    type: 'line',
    title: '</text><script>alert(1)</script>',
    x: ['<b>&'],
    series: [{ name: '"><img src=x>', values: [1] }],
  });

  expect(svg).not.toContain('<script>');
  expect(svg).not.toContain('<img');
  expect(svg).not.toContain('<b>');
  expect(svg).toContain('&lt;script&gt;');
});

test('a non-hex accent falls back to the fixed palette', () => {
  const parsed = parseChartSpec('{"type":"line","series":[{"name":"a","values":[1,2]}]}');
  if (!parsed) throw new Error('spec should parse');

  const svg = renderChartSvg(parsed, { ...colors, accent: 'oklch(0.7 0.1 250)' });

  expect(svg).toContain('#4c8df6');
});

test('a tile can declare that up is bad, so a rising error rate is not green', () => {
  const badWhenUp = render({ type: 'kpi', tiles: [{ label: 'Errors', value: '7', delta: '+0.1%', good: 'down' }] });
  const goodWhenUp = render({ type: 'kpi', tiles: [{ label: 'Requests', value: '7', delta: '+0.1%' }] });
  const neutral = render({ type: 'kpi', tiles: [{ label: 'Errors', value: '7', delta: '0.0%' }] });

  expect(badWhenUp).toContain(`fill="${colors.negative}"`);
  expect(goodWhenUp).toContain(`fill="${colors.positive}"`);
  expect(neutral).toContain(`fill="${colors.muted}"`);
});

test('a hex accent rotates one hue per series', () => {
  const svg = render({ type: 'line', series: [{ name: 'a', values: [1] }, { name: 'b', values: [2] }] });
  const strokes = svg.match(/stroke="#[0-9a-f]{6}"/g) ?? [];

  expect(new Set(strokes).size).toBeGreaterThan(1);
});