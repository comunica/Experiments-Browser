// Shared by the SVG plot scripts: palette, styles, number formatting and raw-file lookup.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PaletteEntry {
  label: string;
  light: string;
  dark: string;
}

// Categorical slots 1-2 of the validated reference palette (light / dark steps), in fixed order.
export const SERIES = [
  { key: 'comunica', label: 'Comunica', light: '#2a78d6', dark: '#3987e5' },
  { key: 'oxigraph', label: 'Oxigraph', light: '#eb6834', dark: '#d95926' },
];

// Categorical slots 1-4 of the validated reference palette, in fixed order, for the breakdown variants.
export const VARIANT_PALETTE: (PaletteEntry & { key: string })[] = [
  { key: 'count', label: 'count: evaluation only', light: '#2a78d6', dark: '#3987e5' },
  { key: 'objects', label: '+ JS result objects', light: '#eb6834', dark: '#d95926' },
  { key: 'full', label: '+ reading every value (timing runs)', light: '#1baf7a', dark: '#199e70' },
  { key: 'json', label: 'serialized JSON + parse + read', light: '#eda100', dark: '#c98500' },
];

export const style = (palette: PaletteEntry[]) => `
  .surface { fill: #fcfcfb; } .ink { fill: #0b0b0b; } .ink2 { fill: #52514e; } .muted { fill: #898781; }
  .grid { stroke: #e1e0d9; } .axis { stroke: #c3c2b7; } .whisker { stroke: #52514e; } .ring { stroke: #fcfcfb; }
  ${palette.map((s, i) => `.s${i} { fill: ${s.light}; } .so${i} { stroke: ${s.light}; }`).join(' ')}
  text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; }
  @media (prefers-color-scheme: dark) {
    .surface { fill: #1a1a19; } .ink { fill: #f0efec; } .ink2 { fill: #c3c2b7; }
    .grid { stroke: #2c2c2a; } .axis { stroke: #383835; } .whisker { stroke: #c3c2b7; } .ring { stroke: #1a1a19; }
    ${palette.map((s, i) => `.s${i} { fill: ${s.dark}; } .so${i} { stroke: ${s.dark}; }`).join(' ')}
  }`;

export type Unit = 'ms' | 'MB' | 'kB';

export const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function formatValue(v: number, unit: Unit): string {
  if (unit === 'ms') {
    if (v >= 1000) {
      return `${Number((v / 1000).toPrecision(3))} s`;
    }
    return `${Number(v.toPrecision(3))} ms`;
  }
  return `${Number(v.toPrecision(4)).toLocaleString('en')} ${unit}`;
}

export function tickLabel(v: number, unit: Unit): string {
  if (unit === 'ms') {
    return v >= 1000 ? `${v / 1000} s` : `${v} ms`;
  }
  return `${v.toLocaleString('en')}${unit === 'MB' ? ' MB' : ' kB'}`;
}

export function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + word.length + 1 > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  return line ? [ ...lines, line ] : lines;
}

export function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The breakdown raw file of a configuration: the full query set if it ran, else a `--queries` subset. */
export function readBreakdownRaw(dir: string, dataset: string, browser: string): any | undefined {
  const files = readdirSync(join(dir, 'raw'));
  const name = [ '', '-subset' ].map(suffix => `breakdown-${dataset}-${browser}-oxigraph${suffix}.json`)
    .find(f => files.includes(f));
  return name ? JSON.parse(readFileSync(join(dir, 'raw', name), 'utf8')) : undefined;
}

/** The timing raw files (one per repetition) of a configuration. */
export function readTimingRaws(dir: string, dataset: string, browser: string, engine: string): any[] {
  const prefix = `timing-${dataset}-${browser}-${engine}-r`;
  return readdirSync(join(dir, 'raw')).filter(f => f.startsWith(prefix) && /-r\d+\.json$/u.test(f))
    .map(f => JSON.parse(readFileSync(join(dir, 'raw', f), 'utf8')));
}
