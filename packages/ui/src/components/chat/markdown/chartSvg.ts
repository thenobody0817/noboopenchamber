import type { CartesianChartSpec, ChartSpec, ChartTile, KpiChartSpec } from './chartSpec';

/**
 * Chart SVG. One fixed-width viewBox scaled by CSS keeps the drawing
 * resolution-independent (the same string is what the download button saves)
 * and keeps layout arithmetic in one coordinate space instead of depending on
 * a measured container width.
 */

export type ChartColors = {
  fg: string;
  muted: string;
  line: string;
  accent: string;
  surface: string;
  positive: string;
  negative: string;
};

const WIDTH = 640;
const TITLE_GAP = 34;
const LEGEND_GAP = 22;
const AXIS_GAP = 26;
const PLOT_HEIGHT = 190;
const SPARK_HEIGHT = 66;
const GUTTER_LEFT = 48;
const GUTTER_RIGHT = 14;
const TILE_HEIGHT = 92;
const TILE_GAP = 12;
const MAX_X_LABELS = 8;
const MAX_Y_TICKS = 6;
const LABEL_CHAR_WIDTH = 6.4;
const BAR_VALUE_LABEL_CELLS = 24;

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };
type Bounds = { min: number; max: number; step: number };

// Themes are Material You accents, so one hue rotated per series reads as a
// set; a non-hex accent (oklch, named) falls back to a fixed set that holds up
// on both light and dark surfaces.
const FALLBACK_SERIES_COLORS = [
  '#4c8df6', '#e8734a', '#3fa66b', '#b07ad6', '#d9a13b', '#3fa8bd', '#d76b9d', '#8a8f98',
];

const parseHex = (value: string): Rgb | null => {
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(hex)) return null;
  const full = hex.length === 3 ? hex.split('').map((char) => char + char).join('') : hex;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
};

const rgbToHsl = ({ r, g, b }: Rgb): Hsl => {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: lightness };
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { h: hue, s: saturation, l: lightness };
};

const channel = (value: number): string => (
  Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')
);

const hslToHex = ({ h, s, l }: Hsl): string => {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const sector = (((h % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  let rgb: [number, number, number];
  if (sector < 1) rgb = [chroma, second, 0];
  else if (sector < 2) rgb = [second, chroma, 0];
  else if (sector < 3) rgb = [0, chroma, second];
  else if (sector < 4) rgb = [0, second, chroma];
  else if (sector < 5) rgb = [second, 0, chroma];
  else rgb = [chroma, 0, second];
  const offset = l - chroma / 2;
  return `#${channel(rgb[0] + offset)}${channel(rgb[1] + offset)}${channel(rgb[2] + offset)}`;
};

const seriesPalette = (accent: string, count: number): string[] => {
  const base = parseHex(accent);
  if (!base) return FALLBACK_SERIES_COLORS.slice(0, count);
  const hsl = rgbToHsl(base);
  return Array.from({ length: count }, (_, index) => hslToHex({
    // Even hue steps keep the series distinguishable; the clamps keep the set
    // restrained, since a vivid accent would otherwise rotate into neon.
    h: hsl.h + (360 / count) * index,
    s: Math.min(0.62, Math.max(0.3, hsl.s)),
    // A pale accent vanishes on a dark surface and a dark one on a light one.
    l: Math.min(0.62, Math.max(0.42, hsl.l)),
  }));
};

const escapeXml = (value: string): string => value.replace(/[&<>"']/g, (char) => {
  switch (char) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    default: return '&apos;';
  }
});

const coord = (value: number): string => {
  const rounded = Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

type TextOptions = {
  fill: string;
  size?: number;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
};

const textEl = (x: number, y: number, content: string, options: TextOptions): string => {
  const attributes = [
    `x="${coord(x)}"`,
    `y="${coord(y)}"`,
    `fill="${escapeXml(options.fill)}"`,
    `font-size="${options.size ?? 12}"`,
  ];
  if (options.weight) attributes.push(`font-weight="${options.weight}"`);
  if (options.anchor) attributes.push(`text-anchor="${options.anchor}"`);
  return `<text ${attributes.join(' ')}>${escapeXml(content)}</text>`;
};

const trimNumber = (value: number): string => (
  Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(3)))
);

/** Axis ticks stay short: 1.2k beats 1200 in a 48px gutter. */
const formatTick = (value: number): string => {
  const abs = Math.abs(value);
  const scaled = (divisor: number, suffix: string): string | null => (
    abs >= divisor ? `${trimNumber(value / divisor)}${suffix}` : null
  );
  return scaled(1e9, 'B') ?? scaled(1e6, 'M') ?? scaled(1e3, 'k') ?? trimNumber(value);
};

const formatValue = (value: number): string => trimNumber(value);

const niceStep = (rough: number): number => {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
};

/** Rounded bounds so the top gridline sits on a readable number. */
const niceBounds = (rawMin: number, rawMax: number): Bounds => {
  let min = Number.isFinite(rawMin) ? rawMin : 0;
  let max = Number.isFinite(rawMax) ? rawMax : 1;
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const step = niceStep((max - min) / 4);
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
};

/** Text is measured by estimate: exact metrics need a DOM, and this runs per block. */
const fitText = (value: string, maxChars: number): string => (
  value.length <= maxChars ? value : `${value.slice(0, Math.max(1, maxChars - 1))}…`
);

const svgRoot = (height: number, label: string, body: string): string => (
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${coord(height)}" width="100%" role="img" aria-label="${escapeXml(label)}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">${body}</svg>`
);

const renderTitle = (spec: ChartSpec, colors: ChartColors, parts: string[]): number => {
  if (!spec.title) return 0;
  parts.push(textEl(spec.kind === 'kpi' ? 0 : GUTTER_LEFT, 16, spec.title, {
    fill: colors.fg,
    size: 14,
    weight: 600,
  }));
  return TITLE_GAP;
};

const renderLegend = (
  series: CartesianChartSpec['series'],
  palette: string[],
  left: number,
  top: number,
  colors: ChartColors,
  parts: string[],
): number => {
  if (!series.some((entry) => entry.name)) return 0;
  const y = top + 12;
  let x = left;
  series.forEach((entry, index) => {
    if (!entry.name) return;
    const fill = escapeXml(palette[index] ?? colors.accent);
    parts.push(`<rect x="${coord(x)}" y="${coord(y - 8)}" width="10" height="10" rx="3" fill="${fill}"/>`);
    parts.push(textEl(x + 16, y, entry.name, { fill: colors.muted, size: 11 }));
    x += 16 + entry.name.length * LABEL_CHAR_WIDTH + 18;
  });
  return LEGEND_GAP;
};

/** Evenly spaced ticks, always including the last category. */
const xLabelIndices = (count: number): number[] => {
  const indices: number[] = [];
  const stride = Math.max(1, Math.ceil(count / MAX_X_LABELS));
  for (let index = 0; index < count; index += stride) indices.push(index);
  const last = count - 1;
  if (indices[indices.length - 1] !== last) {
    // The forced last tick would sit on top of its neighbour.
    if (indices.length > 1 && last - indices[indices.length - 2] < stride / 2) indices.pop();
    indices.push(last);
  }
  return indices;
};

const renderAxisLabels = (
  spec: CartesianChartSpec,
  count: number,
  left: number,
  plotTop: number,
  plotHeight: number,
  colors: ChartColors,
  parts: string[],
): void => {
  const y = plotTop + plotHeight + 16;
  for (const index of xLabelIndices(count)) {
    const label = spec.x?.[index] ?? String(index + 1);
    const x = left + ((WIDTH - left - GUTTER_RIGHT) * (index + 0.5)) / count;
    parts.push(textEl(x, y, label, { fill: colors.muted, size: 10, anchor: 'middle' }));
  }
};

const renderSparkline = (
  spec: CartesianChartSpec,
  palette: string[],
  left: number,
  plotTop: number,
  plotHeight: number,
  plotWidth: number,
  count: number,
  colors: ChartColors,
  parts: string[],
): void => {
  const entry = spec.series[0];
  if (!entry) return;
  const fill = escapeXml(palette[0] ?? colors.accent);
  const bounds = niceBounds(Math.min(...entry.values), Math.max(...entry.values));
  const span = bounds.max - bounds.min || 1;
  const xFor = (index: number): number => left + (plotWidth * (index + 0.5)) / count;
  const yFor = (value: number): number => plotTop + plotHeight - ((value - bounds.min) / span) * plotHeight;
  const points = entry.values.map((value, index) => `${coord(xFor(index))},${coord(yFor(value))}`);
  const baseline = coord(plotTop + plotHeight);

  parts.push(`<path d="M${coord(xFor(0))},${baseline} L${points.join(' L')} L${coord(xFor(entry.values.length - 1))},${baseline} Z" fill="${fill}" fill-opacity="0.12"/>`);
  parts.push(`<polyline points="${points.join(' ')}" fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);

  const lastIndex = entry.values.length - 1;
  const lastValue = entry.values[lastIndex];
  parts.push(`<circle cx="${coord(xFor(lastIndex))}" cy="${coord(yFor(lastValue))}" r="3" fill="${fill}"/>`);
  const label = formatValue(lastValue);
  const anchor = lastIndex >= count - 1 ? 'end' : 'start';
  const labelX = anchor === 'end' ? xFor(lastIndex) - 8 : xFor(lastIndex) + 8;
  parts.push(textEl(labelX, yFor(lastValue) - 8, label, { fill: colors.fg, size: 11, weight: 600, anchor }));
};

const renderBars = (
  spec: CartesianChartSpec,
  palette: string[],
  left: number,
  plotTop: number,
  plotHeight: number,
  plotWidth: number,
  count: number,
  bounds: Bounds,
  colors: ChartColors,
  parts: string[],
): void => {
  const span = bounds.max - bounds.min || 1;
  const yFor = (value: number): number => plotTop + plotHeight - ((value - bounds.min) / span) * plotHeight;
  const zeroY = yFor(Math.min(Math.max(0, bounds.min), bounds.max));
  const band = plotWidth / count;
  const groupWidth = band * 0.68;
  const gap = spec.series.length > 1 ? 2 : 0;
  const barWidth = Math.max(2, (groupWidth - gap * (spec.series.length - 1)) / spec.series.length);
  const showValues = spec.series.length * count <= BAR_VALUE_LABEL_CELLS;

  spec.series.forEach((entry, seriesIndex) => {
    const fill = escapeXml(palette[seriesIndex] ?? colors.accent);
    entry.values.forEach((value, index) => {
      const x = left + band * index + (band - groupWidth) / 2 + seriesIndex * (barWidth + gap);
      const valueY = yFor(value);
      const top = Math.min(valueY, zeroY);
      const height = Math.max(1, Math.abs(valueY - zeroY));
      parts.push(`<rect x="${coord(x)}" y="${coord(top)}" width="${coord(barWidth)}" height="${coord(height)}" rx="2" fill="${fill}"/>`);
      if (!showValues) return;
      const centerX = x + barWidth / 2;
      if (value >= 0) {
        parts.push(textEl(centerX, top - 6, formatValue(value), { fill: colors.fg, size: 10, weight: 600, anchor: 'middle' }));
      } else {
        parts.push(textEl(centerX, top + height + 12, formatValue(value), { fill: colors.fg, size: 10, weight: 600, anchor: 'middle' }));
      }
    });
  });
};

const renderLines = (
  spec: CartesianChartSpec,
  palette: string[],
  left: number,
  plotTop: number,
  plotHeight: number,
  plotWidth: number,
  count: number,
  bounds: Bounds,
  colors: ChartColors,
  parts: string[],
): void => {
  const span = bounds.max - bounds.min || 1;
  const xFor = (index: number): number => left + (plotWidth * (index + 0.5)) / count;
  const showDots = count <= 40;

  spec.series.forEach((entry, seriesIndex) => {
    const fill = escapeXml(palette[seriesIndex] ?? colors.accent);
    const yFor = (value: number): number => plotTop + plotHeight - ((value - bounds.min) / span) * plotHeight;
    const points = entry.values.map((value, index) => `${coord(xFor(index))},${coord(yFor(value))}`);
    parts.push(`<polyline points="${points.join(' ')}" fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
    if (!showDots) return;
    for (const point of points) {
      const [cx, cy] = point.split(',');
      parts.push(`<circle cx="${cx}" cy="${cy}" r="2.5" fill="${fill}"/>`);
    }
  });
};

const renderCartesian = (spec: CartesianChartSpec, colors: ChartColors): string => {
  const sparkline = spec.kind === 'sparkline';
  const series = sparkline ? spec.series.slice(0, 1) : spec.series;
  const left = sparkline ? 2 : GUTTER_LEFT;
  const plotWidth = WIDTH - left - GUTTER_RIGHT;
  const plotHeight = sparkline ? SPARK_HEIGHT : PLOT_HEIGHT;
  const palette = seriesPalette(colors.accent, series.length);
  const count = Math.max(1, ...series.map((entry) => entry.values.length));
  const parts: string[] = [];

  const titleHeight = renderTitle(spec, colors, parts);
  const legendHeight = sparkline ? 0 : renderLegend(series, palette, left, titleHeight, colors, parts);
  const plotTop = titleHeight + legendHeight;

  const flat = series.flatMap((entry) => entry.values);
  const bounds = spec.kind === 'bar'
    ? niceBounds(Math.min(0, ...flat), Math.max(0, ...flat))
    : niceBounds(Math.min(...flat), Math.max(...flat));
  const span = bounds.max - bounds.min || 1;

  if (!sparkline) {
    const yFor = (value: number): number => plotTop + plotHeight - ((value - bounds.min) / span) * plotHeight;
    let ticks = 0;
    for (let value = bounds.min; value <= bounds.max + bounds.step / 2 && ticks < MAX_Y_TICKS; value += bounds.step) {
      const y = yFor(value);
      parts.push(`<line x1="${coord(left)}" y1="${coord(y)}" x2="${coord(WIDTH - GUTTER_RIGHT)}" y2="${coord(y)}" stroke="${escapeXml(colors.line)}" stroke-width="1"/>`);
      parts.push(textEl(left - 8, y + 4, formatTick(value), { fill: colors.muted, size: 10, anchor: 'end' }));
      ticks += 1;
    }
    // Negative bars need a visible baseline, not just another gridline.
    if (bounds.min < 0 && bounds.max > 0) {
      const zeroY = yFor(0);
      parts.push(`<line x1="${coord(left)}" y1="${coord(zeroY)}" x2="${coord(WIDTH - GUTTER_RIGHT)}" y2="${coord(zeroY)}" stroke="${escapeXml(colors.muted)}" stroke-width="1"/>`);
    }
  }

  if (sparkline) {
    renderSparkline({ ...spec, series }, palette, left, plotTop, plotHeight, plotWidth, count, colors, parts);
  } else if (spec.kind === 'bar') {
    renderBars({ ...spec, series }, palette, left, plotTop, plotHeight, plotWidth, count, bounds, colors, parts);
    renderAxisLabels({ ...spec, series }, count, left, plotTop, plotHeight, colors, parts);
  } else {
    renderLines({ ...spec, series }, palette, left, plotTop, plotHeight, plotWidth, count, bounds, colors, parts);
    renderAxisLabels({ ...spec, series }, count, left, plotTop, plotHeight, colors, parts);
  }

  const height = plotTop + plotHeight + (sparkline ? 6 : AXIS_GAP);
  return svgRoot(height, spec.title ?? `${spec.kind} chart`, parts.join(''));
};

/** Rising is good by default (the usual KPI convention); a tile can say otherwise. */
const deltaColor = (tile: ChartTile, colors: ChartColors): string => {
  const delta = tile.delta ?? '';
  if (!delta.startsWith('-') && !delta.startsWith('+')) return colors.muted;
  const rising = !delta.startsWith('-');
  const good = tile.good ?? 'up';
  const isGood = good === 'up' ? rising : !rising;
  return isGood ? colors.positive : colors.negative;
};

const renderKpi = (spec: KpiChartSpec, colors: ChartColors): string => {
  const tiles = spec.tiles;
  const parts: string[] = [];
  const top = renderTitle(spec, colors, parts);
  const tileWidth = (WIDTH - TILE_GAP * (tiles.length - 1)) / tiles.length;
  const inner = Math.max(24, tileWidth - 24);

  // Six tiles across 640px leave ~70px of text room each, so the value size and
  // every string follow from the tile width instead of overflowing it.
  const longestValue = Math.max(...tiles.map((tile) => tile.value.length));
  const valueSize = Math.max(14, Math.min(26, Math.floor(inner / Math.max(3, longestValue) / 0.58)));
  const valueChars = Math.max(3, Math.floor(inner / (valueSize * 0.58)));

  tiles.forEach((tile: ChartTile, index: number) => {
    const x = index * (tileWidth + TILE_GAP);
    parts.push(`<rect x="${coord(x)}" y="${coord(top)}" width="${coord(tileWidth)}" height="${TILE_HEIGHT}" rx="10" fill="${escapeXml(colors.surface)}" stroke="${escapeXml(colors.line)}" stroke-width="1"/>`);
    parts.push(textEl(x + 12, top + 22, fitText(tile.label, Math.floor(inner / 6)), { fill: colors.muted, size: 11 }));
    parts.push(textEl(x + 12, top + 54, fitText(tile.value, valueChars), { fill: colors.fg, size: valueSize, weight: 600 }));
    if (tile.delta) {
      parts.push(textEl(x + 12, top + 76, fitText(tile.delta, Math.floor(inner / 6)), { fill: deltaColor(tile, colors), size: 11 }));
    }
  });

  return svgRoot(top + TILE_HEIGHT, spec.title ?? 'Key numbers', parts.join(''));
};

/** Spec in, standalone SVG string out. Never throws: a bad spec is rejected upstream. */
export const renderChartSvg = (spec: ChartSpec, colors: ChartColors): string => (
  spec.kind === 'kpi' ? renderKpi(spec, colors) : renderCartesian(spec, colors)
);