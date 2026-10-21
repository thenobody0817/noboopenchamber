/**
 * Chart blocks: a ```chart fence carries a small JSON spec that the decorate
 * pass turns into inline SVG, so a reply can carry a real chart without an
 * image, a script or a panel.
 *
 * The spec is model-authored, so parsing stays defensive: unknown keys are
 * ignored, unusable numbers are dropped, and anything that cannot make a
 * chart yields null. A null spec leaves the fence as an ordinary code block,
 * which is also what a half-streamed fence looks like. The caps keep one reply
 * from putting thousands of nodes into the document.
 */

const CHART_MAX_SERIES = 8;
const CHART_MAX_POINTS = 200;
// Labels are indexed by point, so they may not be capped below the point cap —
// a thin chart would otherwise fall back to bare indices past the cut.
const CHART_MAX_LABELS = CHART_MAX_POINTS;
const CHART_MAX_TILES = 6;
const CHART_MAX_LABEL_LENGTH = 64;

export type CartesianChartKind = 'line' | 'bar' | 'sparkline';

export type ChartSeries = {
  name: string;
  values: number[];
};

export type ChartTile = {
  label: string;
  value: string;
  delta?: string;
  /** Which way is good news. Without it a `+` is green, which is wrong for errors. */
  good?: 'up' | 'down';
};

export type CartesianChartSpec = {
  kind: CartesianChartKind;
  title?: string;
  x?: string[];
  series: ChartSeries[];
};

export type KpiChartSpec = {
  kind: 'kpi';
  title?: string;
  tiles: ChartTile[];
};

export type ChartSpec = CartesianChartSpec | KpiChartSpec;

/** Everything `JSON.parse` can hand back: the whole trust boundary of a spec. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export type JsonObject = { [key: string]: JsonValue };

const isJsonObject = (value: JsonValue): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** Labels are user prose: trimmed, capped, and a bare number is fine as a tick. */
const asText = (value: JsonValue | undefined): string | undefined => {
  const text = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : '')
    : (typeof value === 'string' ? value.trim() : '');
  if (!text) return undefined;
  return text.length > CHART_MAX_LABEL_LENGTH
    ? `${text.slice(0, CHART_MAX_LABEL_LENGTH - 1)}…`
    : text;
};

/** Numeric strings are accepted: models quote numbers freely. */
const asFiniteNumber = (value: JsonValue): number | null => {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' ? Number(value.trim()) : Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
};

const readSeries = (value: JsonValue | undefined): ChartSeries[] => {
  if (!Array.isArray(value)) return [];
  const series: ChartSeries[] = [];
  for (const entry of value) {
    if (series.length >= CHART_MAX_SERIES) break;
    const record = isJsonObject(entry) ? entry : null;
    // A bare number array is one unnamed series; `{ name, values }` is the shape.
    const raw = Array.isArray(entry)
      ? entry
      : (record && Array.isArray(record.values) ? record.values : null);
    if (!raw) continue;
    const values: number[] = [];
    for (const item of raw) {
      if (values.length >= CHART_MAX_POINTS) break;
      const parsed = asFiniteNumber(item);
      if (parsed !== null) values.push(parsed);
    }
    if (values.length === 0) continue;
    series.push({ name: (record ? asText(record.name) : undefined) ?? '', values });
  }
  return series;
};

const readLabels = (value: JsonValue | undefined): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const labels: string[] = [];
  for (const entry of value) {
    if (labels.length >= CHART_MAX_LABELS) break;
    const text = asText(entry);
    if (text !== undefined) labels.push(text);
  }
  return labels.length > 0 ? labels : undefined;
};

const readTiles = (value: JsonValue | undefined): ChartTile[] => {
  if (!Array.isArray(value)) return [];
  const tiles: ChartTile[] = [];
  for (const entry of value) {
    if (tiles.length >= CHART_MAX_TILES) break;
    if (!isJsonObject(entry)) continue;
    const label = asText(entry.label ?? entry.name);
    const tileValue = asText(entry.value);
    if (label === undefined || tileValue === undefined) continue;
    const good = entry.good ?? entry.betterWhen;
    tiles.push({
      label,
      value: tileValue,
      delta: asText(entry.delta ?? entry.change),
      good: good === 'up' || good === 'down' ? good : undefined,
    });
  }
  return tiles;
};

/** Null means "leave the fence alone": unknown kind, no plottable data, or not JSON. */
export const parseChartSpec = (source: string): ChartSpec | null => {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` yields exactly the JsonValue domain, or throws into the catch below.
    parsed = JSON.parse(source) as JsonValue;
  } catch {
    return null;
  }

  if (!isJsonObject(parsed)) return null;
  const root = parsed;

  const kind = (asText(root.type) ?? asText(root.kind) ?? '').toLowerCase();
  const title = asText(root.title);

  if (kind === 'kpi') {
    const tiles = readTiles(root.tiles ?? root.items);
    return tiles.length > 0 ? { kind: 'kpi', title, tiles } : null;
  }

  if (kind !== 'line' && kind !== 'bar' && kind !== 'sparkline') return null;
  const series = readSeries(root.series);
  if (series.length === 0) return null;
  return { kind, title, x: readLabels(root.x ?? root.categories ?? root.labels), series };
};