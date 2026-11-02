// Renders the aggregated results as SVG: per dataset and browser a query-time chart (log y, engines side by side),
// plus load-time, memory, bundle-size and Oxigraph breakdown charts. Usage: npm run plot [-- results/<dir>]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { breakdownInstances, DATASETS, instanceStats, resultsDir } from './aggregate';
import {
  esc, formatValue, mean, niceStep, type PaletteEntry, readBreakdownRaw, readTimingRaws, SERIES, style, tickLabel, type Unit,
  VARIANT_PALETTE, wrap,
} from './plot-common';
import { renderSplit } from './plot-split';

const ROOT = resolve(import.meta.dirname, '..');

interface Cell {
  value: number | null;
  /** Short label above the mark, e.g. "1/5" when only some instances are ok. */
  note?: string;
  lo?: number | null;
  hi?: number | null;
  marker?: number | null;
  tooltip: string;
}

interface ChartSpec {
  title: string;
  subtitle: string;
  groups: { label: string; super?: string }[];
  series: number[];
  /** Colours and labels of the series; the engines by default. */
  palette?: PaletteEntry[];
  cells: (group: number, series: number) => Cell;
  log: boolean;
  unit: Unit;
  legendExtras?: ('whisker' | 'marker')[];
  markerLabel?: string;
  whiskerLabel?: string;
  /** Legend text for the cross that marks a missing value. */
  missingLabel?: string;
}

/** Grouped bar chart with one y axis. */
function barChart(spec: ChartSpec): string {
  const barW = 11;
  const barGap = 2;
  const groupW = spec.series.length * barW + (spec.series.length - 1) * barGap;
  const left = 72;
  const right = 24;
  const width = Math.max(720, left + right + spec.groups.length * (groupW + 28));
  // Groups spread over the full plot width.
  const groupGap = (width - left - right) / spec.groups.length - groupW;
  const longest = Math.max(...spec.groups.map(g => g.label.length));
  const rotate = longest * 6 > groupW + groupGap - 2;
  const bottom = (rotate ? Math.min(longest, 28) * 5.2 + 24 : 28) + (spec.groups.some(g => g.super) ? 22 : 0);
  // The subtitle wraps at the chart width; the legend goes below it.
  const subtitle = wrap(spec.subtitle, Math.floor((width - left - right) / 6.4));
  const legendY = 46 + subtitle.length * 16;
  const palette = spec.palette ?? SERIES;
  // Legend items, laid out left to right and wrapped at the chart width.
  type Item = { width: number; draw: (x: number, y: number) => string[] };
  const items: Item[] = spec.series.map(s => ({
    width: 17 + palette[s].label.length * 6.6,
    draw: (x, y) => [ `<rect class="s${s}" x="${x}" y="${y}" width="12" height="12" rx="3"/>`,
      `<text class="ink2" x="${x + 17}" y="${y + 10.5}" font-size="12">${esc(palette[s].label)}</text>` ],
  }));
  if (spec.legendExtras?.includes('whisker')) {
    const label = spec.whiskerLabel ?? 'range';
    items.push({ width: 14 + label.length * 6.4, draw: (x, y) => [
      `<line class="whisker" x1="${x + 5}" x2="${x + 5}" y1="${y - 1}" y2="${y + 13}" stroke-width="1.5"/>`,
      `<text class="ink2" x="${x + 14}" y="${y + 10.5}" font-size="12">${esc(label)}</text>` ] });
  }
  if (spec.legendExtras?.includes('marker')) {
    const label = spec.markerLabel ?? 'marker';
    items.push({ width: 14 + label.length * 6.4, draw: (x, y) => [
      `<circle class="surface" cx="${x + 5}" cy="${y + 6}" r="3.5" stroke="#898781" stroke-width="1.5"/>`,
      `<text class="ink2" x="${x + 14}" y="${y + 10.5}" font-size="12">${esc(label)}</text>` ] });
  }
  if (spec.groups.some((_, g) => spec.series.some(si => spec.cells(g, si).value === null))) {
    const label = spec.missingLabel ?? 'no ok result';
    items.push({ width: 14 + label.length * 6.4, draw: (x, y) => [
      `<path d="M${x + 2} ${y + 3} l6 6 m0 -6 l-6 6" stroke="#898781" stroke-width="1.5" fill="none"/>`,
      `<text class="ink2" x="${x + 14}" y="${y + 10.5}" font-size="12">${esc(label)}</text>` ] });
  }
  if (spec.groups.some((_, g) => spec.series.some(si => spec.cells(g, si).note))) {
    const label = 'k/n: only k of n instances ok';
    items.push({ width: label.length * 6.4, draw: (x, y) => [ `<text class="ink2" x="${x}" y="${y + 10.5}" font-size="12">${esc(label)}</text>` ] });
  }
  const legend: string[] = [];
  let lx = left;
  let ly = legendY;
  for (const item of items) {
    if (lx > left && lx + item.width > width - right) {
      lx = left;
      ly += 20;
    }
    legend.push(...item.draw(lx, ly));
    lx += item.width + 18;
  }
  const top = ly + 32;
  const plotH = 260;
  const height = top + plotH + bottom;

  const all: number[] = [];
  spec.groups.forEach((_, g) => spec.series.forEach((s) => {
    const c = spec.cells(g, s);
    for (const v of [ c.value, c.lo, c.hi, c.marker ]) {
      if (v !== null && v !== undefined && v > 0) {
        all.push(v);
      }
    }
  }));
  const maxV = all.length > 0 ? Math.max(...all) : 1;
  const minV = all.length > 0 ? Math.min(...all) : 1;
  let ticks: number[];
  let y: (v: number) => number;
  let floor: number;
  if (spec.log) {
    const lo = Math.floor(Math.log10(Math.max(minV, 1e-3)));
    const hi = Math.ceil(Math.log10(maxV * 1.0001));
    floor = 10 ** lo;
    ticks = Array.from({ length: hi - lo + 1 }, (_, i) => Number((10 ** (lo + i)).toPrecision(1)));
    y = v => top + plotH - ((Math.log10(Math.max(v, floor)) - lo) / Math.max(hi - lo, 1)) * plotH;
  } else {
    const step = niceStep(maxV / 5);
    const hi = Math.ceil(maxV / step) * step;
    floor = 0;
    ticks = Array.from({ length: Math.round(hi / step) + 1 }, (_, i) => Number((i * step).toPrecision(6)));
    y = v => top + plotH - (v / hi) * plotH;
  }
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(spec.title)}">`);
  out.push(`<style>${style(palette)}</style>`);
  out.push(`<rect class="surface" width="${width}" height="${height}" rx="6"/>`);
  out.push(`<text class="ink" x="${left}" y="26" font-size="16" font-weight="600">${esc(spec.title)}</text>`);
  subtitle.forEach((line, i) => {
    out.push(`<text class="ink2" x="${left}" y="${46 + i * 16}" font-size="12">${esc(line)}</text>`);
  });
  out.push(...legend);
  // Grid and y axis.
  for (const t of ticks) {
    const ty = y(t);
    out.push(`<line class="grid" x1="${left}" x2="${width - right}" y1="${ty}" y2="${ty}" stroke-width="1"/>`);
    out.push(`<text class="muted" x="${left - 8}" y="${ty + 4}" font-size="11" text-anchor="end">${tickLabel(t, spec.unit)}</text>`);
  }
  out.push(`<line class="axis" x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}" stroke-width="1"/>`);
  // Bars.
  let lastSuper: string | undefined;
  let superStart = 0;
  const supers: { label: string; x0: number; x1: number }[] = [];
  spec.groups.forEach((group, g) => {
    const gx = left + groupGap / 2 + g * (groupW + groupGap);
    if (group.super !== lastSuper) {
      if (lastSuper !== undefined) {
        supers.push({ label: lastSuper, x0: superStart, x1: gx - groupGap / 2 });
      }
      lastSuper = group.super;
      superStart = gx - groupGap / 2;
    }
    spec.series.forEach((s, i) => {
      const c = spec.cells(g, s);
      const x = gx + i * (barW + barGap);
      out.push(`<g><title>${esc(c.tooltip)}</title>`);
      out.push(`<rect x="${x - 1}" y="${top}" width="${barW + 2}" height="${plotH}" fill="transparent"/>`);
      if (c.value === null) {
        // No correct result to time: an explicit mark instead of an empty slot.
        const by = top + plotH - 7;
        out.push(`<path d="M${x + 2.5} ${by - 4.5} l6 6 m0 -6 l-6 6" stroke="#898781" stroke-width="1.5" fill="none"/>`);
      } else if (c.value > floor) {
        const y0 = top + plotH;
        const y1 = y(c.value);
        const r = Math.min(3, barW / 2, (y0 - y1) / 2);
        out.push(`<path class="s${s}" d="M${x} ${y0} V${y1 + r} Q${x} ${y1} ${x + r} ${y1} H${x + barW - r} Q${x + barW} ${y1} ${x + barW} ${y1 + r} V${y0} Z"/>`);
      }
      if (c.lo !== undefined && c.lo !== null && c.hi !== undefined && c.hi !== null && c.hi > c.lo) {
        out.push(`<line class="whisker" x1="${x + barW / 2}" x2="${x + barW / 2}" y1="${y(c.lo)}" y2="${y(c.hi)}" stroke-width="1.5"/>`);
      }
      if (c.marker !== undefined && c.marker !== null) {
        out.push(`<circle class="surface so${s}" cx="${x + barW / 2}" cy="${y(c.marker)}" r="3.5" stroke-width="1.5"/>`);
      }
      if (c.note) {
        const tops = [ c.value, c.hi, c.marker ].filter((v): v is number => typeof v === 'number').map(y);
        const noteY = (tops.length > 0 ? Math.min(...tops) : top + plotH - 12) - 7;
        out.push(`<text class="ink2" x="${x + barW / 2}" y="${noteY}" font-size="9" text-anchor="middle">${esc(c.note)}</text>`);
      }
      out.push('</g>');
    });
    const lxg = gx + groupW / 2;
    const ly = top + plotH + 16;
    out.push(rotate ?
      `<text class="ink2" font-size="11" text-anchor="end" transform="translate(${lxg + 3} ${ly - 4}) rotate(-40)">${esc(group.label)}</text>` :
      `<text class="ink2" x="${lxg}" y="${ly}" font-size="11" text-anchor="middle">${esc(group.label)}</text>`);
  });
  if (lastSuper !== undefined) {
    supers.push({ label: lastSuper, x0: superStart, x1: left + groupGap / 2 + spec.groups.length * (groupW + groupGap) - groupGap / 2 });
  }
  for (const sup of supers) {
    const sy = height - 12;
    out.push(`<line class="axis" x1="${sup.x0 + 4}" x2="${sup.x1 - 4}" y1="${sy - 14}" y2="${sy - 14}" stroke-width="1"/>`);
    out.push(`<text class="ink" x="${(sup.x0 + sup.x1) / 2}" y="${sy}" font-size="12" text-anchor="middle" font-weight="600">${esc(sup.label)}</text>`);
  }
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

interface ScatterPanel {
  label: string;
  points: { x: number; y: number; tip: string }[];
  lines?: { slope: number; intercept: number; label: string }[];
}

/** Log-log scatter plot in one or more panels that share their axes; x and y must be positive to be shown. */
function scatterPanels(spec: { title: string; subtitle: string; panels: ScatterPanel[]; xLabel: string }): string {
  const panelW = 420;
  const gap = 36;
  const left = 72;
  const right = 24;
  const width = Math.max(720, left + right + spec.panels.length * panelW + (spec.panels.length - 1) * gap);
  const plotW = (width - left - right - (spec.panels.length - 1) * gap) / spec.panels.length;
  const subtitle = wrap(spec.subtitle, Math.floor((width - left - right) / 6.4));
  const top = 46 + subtitle.length * 16 + 34;
  const plotH = 300;
  const height = top + plotH + 66;
  const shown = spec.panels.flatMap(p => p.points.filter(q => q.x > 0 && q.y > 0));
  const hidden = spec.panels.reduce((a, p) => a + p.points.filter(q => !(q.x > 0 && q.y > 0)).length, 0);
  const xs = shown.map(q => q.x);
  const ys = shown.map(q => q.y);
  const xlo = 0;
  const xhi = Math.ceil(Math.log10(Math.max(10, ...xs)));
  const ylo = Math.floor(Math.log10(Math.min(1, ...ys)));
  const yhi = Math.ceil(Math.log10(Math.max(1, ...ys) * 1.0001));
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(spec.title)}">`);
  out.push(`<style>${style([ SERIES[1] ])}</style>`);
  out.push(`<rect class="surface" width="${width}" height="${height}" rx="6"/>`);
  out.push(`<text class="ink" x="${left}" y="26" font-size="16" font-weight="600">${esc(spec.title)}</text>`);
  subtitle.forEach((line, i) => out.push(`<text class="ink2" x="${left}" y="${46 + i * 16}" font-size="12">${esc(line)}</text>`));
  spec.panels.forEach((panel, pi) => {
    const x0 = left + pi * (plotW + gap);
    const px = (v: number) => x0 + ((Math.log10(v) - xlo) / Math.max(xhi - xlo, 1)) * plotW;
    const py = (v: number) => top + plotH - ((Math.log10(v) - ylo) / Math.max(yhi - ylo, 1)) * plotH;
    out.push(`<text class="ink" x="${x0}" y="${top - 12}" font-size="12" font-weight="600">${esc(panel.label)}</text>`);
    for (let e = ylo; e <= yhi; e++) {
      const v = 10 ** e;
      out.push(`<line class="grid" x1="${x0}" x2="${x0 + plotW}" y1="${py(v)}" y2="${py(v)}" stroke-width="1"/>`);
      if (pi === 0) {
        out.push(`<text class="muted" x="${x0 - 8}" y="${py(v) + 4}" font-size="11" text-anchor="end">${tickLabel(Number(v.toPrecision(1)), 'ms')}</text>`);
      }
    }
    for (let e = xlo; e <= xhi; e++) {
      const v = 10 ** e;
      out.push(`<line class="grid" x1="${px(v)}" x2="${px(v)}" y1="${top}" y2="${top + plotH}" stroke-width="1"/>`);
      out.push(`<text class="muted" x="${px(v)}" y="${top + plotH + 16}" font-size="11" text-anchor="middle">${v.toLocaleString('en')}</text>`);
    }
    out.push(`<line class="axis" x1="${x0}" x2="${x0 + plotW}" y1="${top + plotH}" y2="${top + plotH}" stroke-width="1"/>`);
    out.push(`<text class="ink2" x="${x0 + plotW / 2}" y="${top + plotH + 36}" font-size="12" text-anchor="middle">${esc(spec.xLabel)}</text>`);
    for (const line of panel.lines ?? []) {
      const path: string[] = [];
      let last: [number, number] | undefined;
      for (let i = 0; i <= 60; i++) {
        const x = 10 ** (xlo + (i / 60) * (xhi - xlo));
        const yv = line.intercept + line.slope * x;
        if (yv > 10 ** ylo && yv <= 10 ** yhi) {
          path.push(`${path.length === 0 ? 'M' : 'L'}${px(x).toFixed(1)} ${py(yv).toFixed(1)}`);
          last = [ px(x), py(yv) ];
        }
      }
      if (path.length > 1) {
        out.push(`<g><title>${esc(line.label)}</title><path d="${path.join(' ')}" fill="none" class="whisker" stroke-width="1.5" stroke-dasharray="4 3"/></g>`);
        out.push(`<text class="ink2" x="${last![0] - 4}" y="${last![1] - 6}" font-size="11" text-anchor="end">${esc(line.label)}</text>`);
      }
    }
    for (const q of panel.points.filter(p => p.x > 0 && p.y > 0)) {
      out.push(`<g><title>${esc(q.tip)}</title><circle class="s0 ring" cx="${px(q.x).toFixed(1)}" cy="${py(q.y).toFixed(1)}" r="4" stroke-width="1.5"/></g>`);
    }
  });
  out.push(`<text class="muted" x="${left}" y="${height - 8}" font-size="11">${shown.length} instances shown, ${hidden} not shown (no results or overhead ≤ 0)</text>`);
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

function main(): void {
  const dir = resultsDir(process.argv[2]);
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const engines: string[] = summary.engines;
  const series = SERIES.map((s, i) => engines.includes(s.key) ? i : -1).filter(i => i >= 0);
  const written: string[] = [];
  const write = (file: string, svg: string) => {
    writeFileSync(file, svg);
    written.push(relative(ROOT, file));
  };
  const machine = summary.meta?.machine?.label ?? '';

  // Query times per dataset and browser.
  for (const dataset of DATASETS) {
    const ds = summary.datasets[dataset];
    if (!ds) {
      continue;
    }
    for (const browser of Object.keys(ds.browsers)) {
      const stats = Object.fromEntries(SERIES.map(s => [ s.key, instanceStats(readTimingRaws(dir, dataset, browser, s.key), dataset, 'timing') ]));
      const templates = [ ...new Set(stats[engines[0]].map(s => s.template)) ];
      // An engine that did not run here (skipped, see meta.json) gets no marks, only a note in the subtitle.
      const notRun = SERIES.filter(s => engines.includes(s.key) && stats[s.key].every(x => x.outcome === 'skipped'));
      const chartSeries = series.filter(i => !notRun.includes(SERIES[i]));
      const version = ds.browsers[browser].engines[engines[0]]?.browserVersion ?? '';
      write(join(dir, dataset, `plot_${browser}.svg`), barChart({
        title: `${dataset}: query time in ${browser} ${version}`.trim(),
        subtitle: `Bar: warm mean (${Math.max(...Object.values<any>(ds.browsers[browser].engines).map((e: any) => e.repetitions))} ` +
          `repetition(s) × ${summary.meta?.settings?.rounds ?? 5} timed rounds), averaged over the template's ok instances; ` +
          `whisker: fastest to slowest instance; circle: cold run (mean over repetitions). Log scale. ${machine}` +
          notRun.map(s => `. ${s.label}: not completed in this browser, see the results README`).join(''),
        groups: templates.map(t => ({ label: t })),
        series: chartSeries,
        cells: (g, si) => {
          const key = SERIES[si].key;
          const inst = stats[key].filter(s => s.template === templates[g]);
          const ok = inst.filter(s => s.outcome === 'ok');
          const bad = inst.filter(s => s.outcome !== 'ok');
          const failed = bad.length > 0 ? `; not ok: ${bad.map(s => `${s.query} ${s.outcome}`).join(', ')}` : '';
          if (ok.length === 0) {
            return { value: null, tooltip: `${SERIES[si].label}, ${templates[g]}: no ok instance${failed}` };
          }
          const means = ok.map(s => s.mean!);
          const colds = ok.map(s => s.cold!).filter(x => x !== null);
          const v = mean(means);
          return {
            value: v,
            note: ok.length < inst.length ? `${ok.length}/${inst.length}` : undefined,
            lo: Math.min(...means),
            hi: Math.max(...means),
            marker: colds.length > 0 ? mean(colds) : null,
            tooltip: `${SERIES[si].label}, ${templates[g]}: warm ${formatValue(v, 'ms')} (instances ${formatValue(Math.min(...means), 'ms')}–${formatValue(Math.max(...means), 'ms')}), ` +
              `cold ${colds.length > 0 ? formatValue(mean(colds), 'ms') : 'n/a'}, ${ok.length}/${inst.length} ok${failed}`,
          };
        },
        log: true,
        unit: 'ms',
        legendExtras: [ 'whisker', 'marker' ],
        whiskerLabel: 'instance range',
        markerLabel: 'cold run',
      }));
    }
  }

  // Load time (parse + ingest), every dataset and browser.
  const loadGroups: { label: string; super: string; dataset: string; browser: string }[] = [];
  for (const dataset of DATASETS) {
    for (const browser of Object.keys(summary.datasets[dataset]?.browsers ?? {})) {
      loadGroups.push({ label: browser, super: dataset, dataset, browser });
    }
  }
  if (loadGroups.length > 0) {
    const entry = (g: number, si: number) => summary.datasets[loadGroups[g].dataset].browsers[loadGroups[g].browser].engines[SERIES[si].key];
    write(join(dir, 'plot_load.svg'), barChart({
      title: 'Load time (parse + ingest) per dataset and browser',
      subtitle: `Median over repetitions; whisker: fastest to slowest run. Comunica: N3.js parse + ordered rdf-stores build. ` +
        `Oxigraph: Store.load(). Excludes fetch + inflate. Log scale. ${machine}`,
      groups: loadGroups,
      series,
      legendExtras: [ 'whisker' ],
      whiskerLabel: 'range over runs',
      missingLabel: 'not measured',
      cells: (g, si) => {
        const e = entry(g, si);
        return {
          value: e?.loadMs ?? null,
          lo: e?.load?.min,
          hi: e?.load?.max,
          tooltip: e?.loadMs ? `${SERIES[si].label}, ${loadGroups[g].super} ${loadGroups[g].label}: load ${formatValue(e.loadMs, 'ms')} ` +
            `(${formatValue(e.load.min, 'ms')}–${formatValue(e.load.max, 'ms')} over ${e.repetitions} runs), engine init ${formatValue(e.initMs, 'ms')}` :
            `${SERIES[si].label}: did not load (${e?.status ?? 'skipped'})`,
        };
      },
      log: true,
      unit: 'ms',
    }));

    // Memory after load (Chromium only).
    const memGroups = DATASETS.filter(d => summary.datasets[d]?.browsers.chromium).map(d => ({ label: d }));
    if (memGroups.length > 0) {
      const method = summary.datasets[memGroups[0].label].browsers.chromium.engines[engines[0]]?.memoryMethod;
      write(join(dir, 'plot_memory.svg'), barChart({
        title: 'Memory after load in Chromium',
        subtitle: `${method === 'measureUserAgentSpecificMemory' ? 'performance.measureUserAgentSpecificMemory()' : `Method: ${method}`} after gc(), before any query; ` +
          `includes Oxigraph's WASM memory. Median over repetitions; whisker: range. Log scale. ${machine}`,
        groups: memGroups,
        series,
        cells: (g, si) => {
          const e = summary.datasets[memGroups[g].label].browsers.chromium.engines[SERIES[si].key];
          return {
            value: e?.memoryMB ?? null,
            lo: e?.memory?.min,
            hi: e?.memory?.max,
            tooltip: e?.memoryMB ? `${SERIES[si].label}, ${memGroups[g].label}: ${formatValue(e.memoryMB, 'MB')} (${e.memoryMethod}${e.wasmMemoryMB ? `; WASM memory ${formatValue(e.wasmMemoryMB, 'MB')}` : ''})` :
              `${SERIES[si].label}: no measurement`,
          };
        },
        log: true,
        unit: 'MB',
        legendExtras: [ 'whisker' ],
        whiskerLabel: 'range over runs',
        missingLabel: 'not measured',
      }));
    }
  }

  // Oxigraph breakdown: totals per dataset and browser, and per template for each dataset and browser.
  const breakdowns = Object.values<any>(summary.breakdown ?? {}).filter(b => !b.pooled);
  if (breakdowns.length > 0) {
    // Overhead (full - count) against the number of results, one panel per browser, all datasets pooled.
    const panels = [ ...new Set(breakdowns.map(b => b.browser)) ].map((browser) => {
      const entries = breakdowns.filter(b => b.browser === browser && b.dataset !== 'calibration');
      const pooled = summary.breakdown[`all/${browser}`]?.perResult;
      const widths = summary.breakdown[`calibration/${browser}`]?.widths ?? {};
      return {
        label: `${browser}: fit over these queries ${pooled?.fitPerRow ? `${pooled.fitPerRow.usPerRow.toFixed(2)} µs per result, ` +
          `R² ${pooled.fitPerRow.r2.toFixed(2)}` : 'n/a'}`,
        points: entries.flatMap(b => b.points.map((p: any) => ({ x: p.rows, y: p.transfer,
          tip: `${b.dataset} ${p.query}: ${p.rows} results, ${p.terms} terms, overhead ${formatValue(p.transfer, 'ms')}` }))),
        // The calibrated cost per result, for 1 and 3 variables, as a reference.
        lines: Object.entries<any>(widths).filter(([ , w ]) => w.perResult.fitPerRow).map(([ width, w ]) => ({
          slope: w.perResult.fitPerRow.usPerRow / 1000,
          intercept: 0,
          label: `calibration, ${width} variable${width === '1' ? '' : 's'}: ${w.perResult.fitPerRow.usPerRow.toFixed(2)} µs/result`,
        })),
      };
    });
    write(join(dir, 'plot_oxigraph_overhead.svg'), scatterPanels({
      title: 'Oxigraph: overhead of moving results into JavaScript against the number of results',
      subtitle: 'Each point is a benchmark query instance; overhead = full − count, measured per query. Dashed: the cost ' +
        'per result measured on the calibration scans. Points far above the lines are differences between the COUNT ' +
        'and plain plans or run-to-run noise, not transfer. Instances without results or with an overhead at or below ' +
        `zero cannot be shown on log axes. ${machine}`,
      panels,
      xLabel: 'results',
    }));
    const variants = VARIANT_PALETTE.map((_, i) => i);
    write(join(dir, 'plot_oxigraph_breakdown.svg'), barChart({
      title: 'Oxigraph: evaluation against moving results into JavaScript',
      subtitle: 'Total time per variant over the SELECT instances that have all four variants. "count" is a lower bound ' +
        `on evaluation; "+ reading every value" is what the timing runs measure. Log scale. ${machine}`,
      groups: breakdowns.map(b => ({ label: b.browser, super: b.dataset })),
      series: variants,
      palette: VARIANT_PALETTE,
      cells: (g, vi) => {
        const b = breakdowns[g];
        const v = b.totals[VARIANT_PALETTE[vi].key];
        return {
          value: b.complete > 0 ? v : null,
          tooltip: `${b.dataset} ${b.browser}, ${VARIANT_PALETTE[vi].label}: ${formatValue(v, 'ms')} over ${b.complete} instances` +
            ` (${b.terms.toLocaleString('en')} terms)`,
        };
      },
      log: true,
      unit: 'ms',
    }));
    for (const b of breakdowns) {
      const raw = readBreakdownRaw(dir, b.dataset, b.browser);
      if (!raw) {
        continue;
      }
      const rows = breakdownInstances(raw, b.dataset);
      const templates = [ ...new Set(rows.map(r => r.template)) ];
      write(join(dir, b.dataset, `plot_oxigraph_breakdown_${b.browser}.svg`), barChart({
        title: `${b.dataset}: Oxigraph time per variant in ${b.browser} ${b.browserVersion}`,
        subtitle: `Mean over the template's instances that ran the variant (${summary.meta?.settings?.breakdownRounds ?? 3} timed ` +
          `rounds each). "count" exists for SELECT queries only. Log scale. ${machine}`,
        groups: templates.map(t => ({ label: t })),
        series: variants,
        palette: VARIANT_PALETTE,
        cells: (g, vi) => {
          const key = VARIANT_PALETTE[vi].key;
          const values = rows.filter(r => r.template === templates[g] && typeof r[key] === 'number').map(r => r[key] as number);
          const all = rows.filter(r => r.template === templates[g]).length;
          if (values.length === 0) {
            return { value: null, tooltip: `${templates[g]}, ${VARIANT_PALETTE[vi].label}: not run` };
          }
          return {
            value: mean(values),
            lo: Math.min(...values),
            hi: Math.max(...values),
            note: values.length < all ? `${values.length}/${all}` : undefined,
            tooltip: `${templates[g]}, ${VARIANT_PALETTE[vi].label}: ${formatValue(mean(values), 'ms')} over ${values.length} instances`,
          };
        },
        log: true,
        unit: 'ms',
        legendExtras: [ 'whisker' ],
        whiskerLabel: 'instance range',
        missingLabel: 'not run',
      }));
    }
  }

  // Bundle sizes.
  if (summary.bundleSizes) {
    const pages: Record<string, any> = Object.fromEntries(summary.bundleSizes.map((s: any) => [ s.page, s ]));
    const metrics = [
      { label: 'JS raw', key: 'jsRaw' }, { label: 'JS gzip', key: 'jsGzip' },
      { label: 'WASM raw', key: 'wasmRaw' }, { label: 'WASM gzip', key: 'wasmGzip' },
      { label: 'total raw', key: 'totalRaw' }, { label: 'total gzip', key: 'totalGzip' },
    ];
    write(join(dir, 'plot_bundle.svg'), barChart({
      title: 'Bundle size per engine page',
      subtitle: 'Everything the page loads: harness, adapter, engine JS and WASM. gzip level 9. 1 kB = 1000 bytes.',
      groups: metrics.map(m => ({ label: m.label })),
      series,
      cells: (g, si) => {
        const bytes = pages[SERIES[si].key]?.[metrics[g].key];
        return {
          value: bytes === undefined ? null : bytes / 1000,
          tooltip: `${SERIES[si].label}, ${metrics[g].label}: ${bytes === undefined ? 'n/a' : formatValue(bytes / 1000, 'kB')}`,
        };
      },
      log: false,
      unit: 'kB',
    }));
  }
  // Oxigraph's time split into evaluation and transfer (also available alone: npm run plot:split).
  written.push(...renderSplit(dir, summary, { overhead: 'calibrated' }));
  console.log(`Wrote ${written.length} files:\n  ${written.join('\n  ')}`);
}

main();
