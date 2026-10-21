import { expect, test } from 'bun:test';
import { parseChartSpec } from './chartSpec';

test('a line chart keeps its title, axis labels and series', () => {
  const spec = parseChartSpec(JSON.stringify({
    type: 'line',
    title: 'Loss per step',
    x: ['1k', '2k', '3k'],
    series: [{ name: 'healthy', values: [2.1, 1.4, 0.9] }],
  }));

  expect(spec).toEqual({
    kind: 'line',
    title: 'Loss per step',
    x: ['1k', '2k', '3k'],
    series: [{ name: 'healthy', values: [2.1, 1.4, 0.9] }],
  });
});

test('a bare array of numbers is one unnamed series', () => {
  expect(parseChartSpec('{"type":"bar","series":[[3,5,8]]}')).toEqual({
    kind: 'bar',
    title: undefined,
    x: undefined,
    series: [{ name: '', values: [3, 5, 8] }],
  });
});

test('numeric strings and quoted kinds are accepted, unknown keys ignored', () => {
  const spec = parseChartSpec('{"kind":"BAR","series":[{"name":"a","values":["1","2"],"oops":true}],"note":"hi"}');

  expect(spec?.kind).toBe('bar');
  expect(spec && 'series' in spec ? spec.series : null).toEqual([{ name: 'a', values: [1, 2] }]);
});

test('unusable values are dropped rather than rendered as NaN', () => {
  const spec = parseChartSpec('{"type":"line","series":[{"name":"a","values":[1,"x",null,3,{},4]}]}');

  expect(spec && 'series' in spec ? spec.series[0]?.values : null).toEqual([1, 3, 4]);
});

test('kpi tiles accept value aliases and cap at six', () => {
  const spec = parseChartSpec(JSON.stringify({
    type: 'kpi',
    title: 'Today',
    tiles: [
      { label: 'Requests', value: 1284, delta: '+12%' },
      { name: 'p95', value: '310ms', change: '-8%' },
      ...Array.from({ length: 8 }, (_, index) => ({ label: `t${index}`, value: index })),
    ],
  }));

  expect(spec?.kind).toBe('kpi');
  expect(spec?.kind === 'kpi' ? spec.tiles.length : 0).toBe(6);
  expect(spec?.kind === 'kpi' ? spec.tiles[0] : null).toEqual({ label: 'Requests', value: '1284', delta: '+12%' });
  expect(spec?.kind === 'kpi' ? spec.tiles[1] : null).toEqual({ label: 'p95', value: '310ms', delta: '-8%' });
});

test('long labels are truncated instead of overflowing the chart', () => {
  const spec = parseChartSpec(JSON.stringify({
    type: 'kpi',
    tiles: [{ label: 'x'.repeat(200), value: 1 }],
  }));

  const label = spec?.kind === 'kpi' ? spec.tiles[0]?.label ?? '' : '';
  expect(label.length).toBe(64);
  expect(label.endsWith('…')).toBe(true);
});

test('specs that cannot make a chart parse to null', () => {
  // Mid-stream JSON, plain prose, an unknown kind, and data-less kinds all keep
  // the fence as an ordinary code block.
  expect(parseChartSpec('{"type":"line","series":[{"name":"a","val')).toBeNull();
  expect(parseChartSpec('just some text')).toBeNull();
  expect(parseChartSpec('{"type":"pie","series":[{"values":[1]}]}')).toBeNull();
  expect(parseChartSpec('{"type":"line","series":[]}')).toBeNull();
  expect(parseChartSpec('{"type":"kpi","tiles":[{"label":"a"}]}')).toBeNull();
  expect(parseChartSpec('[]')).toBeNull();
});

test('series and points are capped', () => {
  const spec = parseChartSpec(JSON.stringify({
    type: 'line',
    series: Array.from({ length: 20 }, (_, index) => ({
      name: `s${index}`,
      values: Array.from({ length: 500 }, (_, point) => point),
    })),
  }));

  expect(spec && 'series' in spec ? spec.series.length : 0).toBe(8);
  expect(spec && 'series' in spec ? spec.series[0]?.values.length : 0).toBe(200);
});