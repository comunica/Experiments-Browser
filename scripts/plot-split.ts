// Stacked bars of Oxigraph's query time, split into evaluation and moving the results from WASM into JavaScript,
// from the breakdown runs: per dataset and browser one row per template, plus an overview with one row per dataset,
// and (calibrated only) the templates with the most transfer next to Comunica's times from the timing runs.
// Usage: npm run plot:split [-- results/<dir>] [--overhead calibrated|measured] [--browsers chromium,firefox] [--top 5]
//   calibrated (default): transfer = result terms × the per-term cost fitted on the calibration scans in that browser.
//   measured: transfer = full − count of each query, which is noisy for single queries.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BROWSERS, breakdownInstances, DATASETS, instanceStats, resultsDir, round, VARIANTS, writeCsv } from './aggregate';
import { esc, formatValue, mean, niceStep, readBreakdownRaw, readTimingRaws, style, tickLabel, wrap } from './plot-common';

const ROOT = resolve(import.meta.dirname, '..');

// Categorical slots 1-3: Comunica, Oxigraph (its evaluation), and Oxigraph's transfer, so that the engines keep their
// colours from the other charts. The split charts show Oxigraph only and use slots 2-3.
const ENGINE_PALETTE = [
  { label: 'Comunica', light: '#2a78d6', dark: '#3987e5' },
  { label: 'Oxigraph: evaluation', light: '#eb6834', dark: '#d95926' },
  { label: 'Oxigraph: WASM → JS transfer (estimated)', light: '#1baf7a', dark: '#199e70' },
];
const PALETTE = ENGINE_PALETTE.slice(1);

// Value labels get a surface-coloured outline, so gridlines do not run through them.
const HALO = `
  .halo { paint-order: stroke; stroke: #fcfcfb; stroke-width: 4px; stroke-linejoin: round; }
  @media (prefers-color-scheme: dark) { .halo { stroke: #1a1a19; } }`;

export type OverheadSource = 'calibrated' | 'measured';

interface SplitRow {
  label: string;
  /** Full time in ms: the bar length. */
  total: number;
  /** Transfer in ms, drawn within [0, total]. */
  overhead: number;
  timeLabel: string;
  shareLabel: string;
  tooltip: string;
  /** Heading drawn above this row. */
  heading?: string;
}

interface SplitSpec {
  title: string;
  subtitle: string;
  legend: [string, string];
  rows: SplitRow[];
  /** 'time': bars on a linear ms axis; 'share': the same split as a share of each row's time. */
  panels: ('time' | 'share')[];
}

const pct = (x: number) => {
  const v = 100 * x;
  return v === 0 ? '0%' : v < 0.1 ? '<0.1%' : v < 10 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
};

/** Bar with a square start and a rounded data end (radius ≤ 4). */
function bar(cls: string, x: number, y: number, w: number, h: number, rounded: boolean): string {
  const r = rounded ? Math.min(4, w / 2, h / 2) : 0;
  if (r <= 0) {
    return `<rect class="${cls}" x="${x.toFixed(1)}" y="${y}" width="${Math.max(w, 0).toFixed(1)}" height="${h}"/>`;
  }
  const x1 = x + w;
  return `<path class="${cls}" d="M${x.toFixed(1)} ${y} H${(x1 - r).toFixed(1)} Q${x1.toFixed(1)} ${y} ${x1.toFixed(1)} ${y + r} ` +
    `V${y + h - r} Q${x1.toFixed(1)} ${y + h} ${(x1 - r).toFixed(1)} ${y + h} H${x.toFixed(1)} Z"/>`;
}

/** Evaluation then transfer, with a 2 px surface gap between them; a segment under 1 px is not drawn. */
function stack(x: number, y: number, h: number, evalW: number, transferW: number, [ ev, tr ] = [ 's0', 's1' ]): string[] {
  if (transferW < 1) {
    return [ bar(ev, x, y, Math.max(evalW + transferW, 1), h, true) ];
  }
  if (evalW < 1) {
    return [ bar(tr, x, y, evalW + transferW, h, true) ];
  }
  return [ bar(ev, x, y, evalW - 1, h, false), bar(tr, x + evalW + 1, y, transferW - 1, h, true) ];
}

function splitChart(spec: SplitSpec): string {
  const width = 960;
  const margin = 24;
  const pitch = 22;
  const barH = 12;
  const left = margin + Math.max(48, ...spec.rows.map(r => r.label.length * 6.4)) + 10;
  const showTime = spec.panels.includes('time');
  const textW = (texts: string[]) => Math.max(...texts.map(t => t.length)) * 6.2 + 12;
  const timeTipW = showTime ? textW(spec.rows.map(r => r.timeLabel)) : 0;
  const shareTipW = textW(spec.rows.map(r => r.shareLabel));
  const gap = 32;
  const avail = width - left - margin;
  const shareW = showTime ? 300 : avail - shareTipW;
  const timeW = showTime ? avail - timeTipW - gap - shareW - shareTipW : 0;
  const shareX = showTime ? left + timeW + timeTipW + gap : left;

  const subtitle = wrap(spec.subtitle, Math.floor((width - 2 * margin) / 6.3));
  const legendY = 46 + subtitle.length * 16;
  const headerY = legendY + 40;
  // Row positions, with room for headings.
  let y = headerY + 16;
  const placed = spec.rows.map((row) => {
    if (row.heading) {
      y += 26;
    }
    const rowY = y;
    y += pitch;
    return { row, y: rowY };
  });
  const rowsEnd = y;
  const height = rowsEnd + 40;

  const maxT = Math.max(...spec.rows.map(r => r.total), 1e-9);
  const step = niceStep(maxT / 4);
  const hiT = Math.ceil(maxT / step) * step;
  const tx = (v: number) => (v / hiT) * timeW;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(spec.title)}">`);
  out.push(`<style>${style(PALETTE)}${HALO}</style>`);
  out.push(`<rect class="surface" width="${width}" height="${height}" rx="6"/>`);
  out.push(`<text class="ink" x="${margin}" y="26" font-size="16" font-weight="600">${esc(spec.title)}</text>`);
  subtitle.forEach((line, i) => out.push(`<text class="ink2" x="${margin}" y="${46 + i * 16}" font-size="12">${esc(line)}</text>`));
  let lx = margin;
  spec.legend.forEach((label, i) => {
    out.push(`<rect class="s${i}" x="${lx}" y="${legendY}" width="12" height="12" rx="3"/>`);
    out.push(`<text class="ink2" x="${lx + 17}" y="${legendY + 10.5}" font-size="12">${esc(label)}</text>`);
    lx += 17 + label.length * 6.6 + 22;
  });

  // Panel headings, grid and x axes.
  const gridTop = headerY + 8;
  const panels: { x: number; w: number; title: string; ticks: { at: number; label: string }[] }[] = [];
  if (showTime) {
    panels.push({ x: left, w: timeW, title: 'Time per query (linear scale)',
      ticks: Array.from({ length: Math.round(hiT / step) + 1 }, (_, i) => {
        const v = Number((i * step).toPrecision(6));
        return { at: left + tx(v), label: tickLabel(v, 'ms') };
      }) });
  }
  panels.push({ x: shareX, w: shareW, title: 'Share of the time',
    ticks: [ 0, 0.25, 0.5, 0.75, 1 ].map(s => ({ at: shareX + s * shareW, label: `${100 * s}%` })) });
  for (const p of panels) {
    out.push(`<text class="ink" x="${p.x}" y="${headerY}" font-size="12" font-weight="600">${esc(p.title)}</text>`);
    for (const t of p.ticks) {
      out.push(`<line class="grid" x1="${t.at.toFixed(1)}" x2="${t.at.toFixed(1)}" y1="${gridTop}" y2="${rowsEnd}" stroke-width="1"/>`);
      out.push(`<text class="muted" x="${t.at.toFixed(1)}" y="${rowsEnd + 16}" font-size="11" text-anchor="middle">${esc(t.label)}</text>`);
    }
    out.push(`<line class="axis" x1="${p.x}" x2="${p.x}" y1="${gridTop}" y2="${rowsEnd}" stroke-width="1"/>`);
  }

  for (const { row, y: rowY } of placed) {
    const by = rowY + (pitch - barH) / 2;
    if (row.heading) {
      // A surface band hides the grid behind the heading.
      out.push(`<rect class="surface" x="${margin}" y="${rowY - 21}" width="${width - 2 * margin}" height="21"/>`);
      out.push(`<line class="axis" x1="${margin}" x2="${width - margin}" y1="${rowY - 20}" y2="${rowY - 20}" stroke-width="1"/>`);
      out.push(`<text class="ink2" x="${margin}" y="${rowY - 6}" font-size="11" font-weight="600">${esc(row.heading)}</text>`);
    }
    const transfer = Math.min(Math.max(row.overhead, 0), row.total);
    out.push(`<g><title>${esc(row.tooltip)}</title>`);
    out.push(`<rect x="${margin}" y="${rowY}" width="${width - 2 * margin}" height="${pitch}" fill="transparent"/>`);
    out.push(`<text class="ink2" x="${left - 10}" y="${by + 10}" font-size="11" text-anchor="end">${esc(row.label)}</text>`);
    if (showTime) {
      out.push(...stack(left, by, barH, tx(row.total - transfer), tx(transfer)));
      out.push(`<text class="ink2 halo" x="${(left + Math.max(tx(row.total), 1) + 6).toFixed(1)}" y="${by + 10}" font-size="11">${esc(row.timeLabel)}</text>`);
    }
    const share = row.total > 0 ? transfer / row.total : 0;
    out.push(...stack(shareX, by, barH, (1 - share) * shareW, share * shareW));
    out.push(`<text class="ink2" x="${(shareX + shareW + 6).toFixed(1)}" y="${by + 10}" font-size="11">${esc(row.shareLabel)}</text>`);
    out.push('</g>');
  }
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

/**
 * Writes `plot_oxigraph_split[_measured].svg` and `oxigraph_split[_measured].csv` (one row per dataset and browser)
 * and, per dataset and browser, `<dataset>/plot_oxigraph_split[_measured]_<browser>.svg` and its CSV (one row per
 * template). Returns the written paths, relative to the repository.
 */
export function renderSplit(dir: string, summary: any, options: { overhead: OverheadSource; browsers?: string[]; top?: number }): string[] {
  const written: string[] = [];
  const write = (file: string, svg: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, svg);
    written.push(relative(ROOT, file));
  };
  const suffix = options.overhead === 'measured' ? '_measured' : '';
  const machine = summary.meta?.machine?.label ?? '';
  const rounds = summary.meta?.settings?.breakdownRounds ?? 3;
  const order = [ ...DATASETS, 'calibration' ];
  const entries = Object.values<any>(summary.breakdown ?? {})
    .filter(b => !b.pooled && order.includes(b.dataset) && (!options.browsers || options.browsers.includes(b.browser)))
    .sort((a, b) => order.indexOf(a.dataset) - order.indexOf(b.dataset) || BROWSERS.indexOf(a.browser) - BROWSERS.indexOf(b.browser));
  const multipleBrowsers = new Set(entries.map(b => b.browser)).size > 1;
  const rateOf = (browser: string): number | undefined => summary.breakdown?.[`calibration/${browser}`]?.perResult?.fitPerTerm?.usPerTerm;
  const source = (browser: string) => options.overhead === 'calibrated' ?
    `estimated as result terms × ${rateOf(browser)!.toFixed(2)} µs (calibration fit, ${browser})` :
    'measured per query as full − count';

  const overview: SplitRow[] = [];
  const overviewCsv: (string | number)[][] = [];
  for (const b of entries) {
    const rate = rateOf(b.browser);
    if (options.overhead === 'calibrated' && !rate) {
      console.warn(`${b.dataset}/${b.browser}: no calibration run in this browser, so no estimate; skipped`);
      continue;
    }
    const raw = readBreakdownRaw(dir, b.dataset, b.browser);
    if (!raw) {
      continue;
    }
    const all = breakdownInstances(raw, b.dataset);
    // The instances that ran all four variants: the same set as the breakdown totals in the results README.
    const instances = all.filter(r => VARIANTS.every(v => typeof r[v] === 'number')).map((r): Record<string, any> => ({
      ...r,
      measured: r.full - r.count,
      overhead: options.overhead === 'calibrated' ? r.terms * rate! / 1000 : r.full - r.count,
    }));
    if (instances.length === 0) {
      continue;
    }
    const name = `${b.dataset}${b.querySubset ? ` (${b.querySubset.length} queries)` : ''}`;

    // One row per template: means over its instances.
    const templates = [ ...new Set(instances.map(r => r.template)) ];
    const csv: (string | number)[][] = [];
    const rows: SplitRow[] = templates.map((t) => {
      const of = instances.filter(r => r.template === t);
      const n = all.filter(r => r.template === t).length;
      const full = mean(of.map(r => r.full));
      const overhead = mean(of.map(r => r.overhead));
      const measured = mean(of.map(r => r.measured));
      const transfer = Math.min(Math.max(overhead, 0), full);
      const flag = overhead < 0 ? ' (measured < 0)' : overhead > full ? ' (estimate > full)' : '';
      csv.push([ t, of.length, n, round(mean(of.map(r => r.rows)), 1), round(mean(of.map(r => r.terms)), 1), round(full, 4),
        round(full - transfer, 4), round(transfer, 4), round(full > 0 ? transfer / full : 0, 4), round(measured, 4) ]);
      return {
        label: t,
        total: full,
        overhead: transfer,
        timeLabel: `${formatValue(full, 'ms')}${of.length < n ? ` (${of.length}/${n})` : ''}`,
        shareLabel: of.every(r => r.terms === 0) ? '0% (no results)' : `${pct(full > 0 ? transfer / full : 0)}${flag}`,
        tooltip: `${b.dataset} ${t}, mean over ${of.length} instance(s): full ${formatValue(full, 'ms')}, evaluation ` +
          `${formatValue(full - transfer, 'ms')}, transfer ${formatValue(transfer, 'ms')} (${source(b.browser)}); measured ` +
          `full − count ${formatValue(Math.abs(measured), 'ms')}${measured < 0 ? ' below zero' : ''}; ` +
          `${round(mean(of.map(r => r.rows)), 1)} results, ${round(mean(of.map(r => r.terms)), 1)} terms`,
      };
    });
    const missing = [ ...new Set(all.filter(r => !VARIANTS.every(v => typeof r[v] === 'number')).map(r => r.template)) ]
      .filter(t => !templates.includes(t));
    const subtitle = `Bar: the full time of a query (what the timing runs measure), mean over each template's instances ` +
      `(${rounds} timed rounds each). Transfer: ${options.overhead === 'calibrated' ?
        `the instance's result terms × ${rate!.toFixed(2)} µs, the cost per term fitted on the calibration scans in ` +
        `${b.browser}; evaluation: the rest. Per query, full − count is too noisy to split single queries.` :
        'full − count of each instance, with count (the query wrapped in COUNT(*)) as evaluation. Differences below a ' +
        'query\'s run-to-run variation are noise; negative ones are drawn as 0.'}` +
      `${missing.length > 0 ? ` Not shown (no count variant or not run): ${missing.join(', ')}.` : ''} ${machine}`;
    write(join(dir, b.dataset, `plot_oxigraph_split${suffix}_${b.browser}.svg`), splitChart({
      title: `${name}: Oxigraph evaluation against WASM → JS transfer, ${b.browser} ${b.browserVersion}`,
      subtitle,
      legend: [ 'evaluation', `WASM → JS transfer (${options.overhead === 'calibrated' ? 'estimated' : 'measured'})` ],
      rows,
      panels: [ 'time', 'share' ],
    }));
    writeCsv(join(dir, b.dataset, `oxigraph_split${suffix}_${b.browser}.csv`), [ 'template', 'instances', 'instances_total',
      'results', 'terms', 'full_ms', 'evaluation_ms', 'transfer_ms', 'transfer_share', 'measured_full_minus_count_ms' ], csv);
    written.push(relative(ROOT, join(dir, b.dataset, `oxigraph_split${suffix}_${b.browser}.csv`)));

    // Overview: totals over the instances.
    const full = instances.reduce((a, r) => a + r.full, 0);
    const overhead = instances.reduce((a, r) => a + r.overhead, 0);
    const transfer = Math.min(Math.max(overhead, 0), full);
    overview.push({
      label: multipleBrowsers ? `${name} · ${b.browser}` : name,
      total: full,
      overhead: transfer,
      timeLabel: formatValue(full, 'ms'),
      shareLabel: `${formatValue(transfer, 'ms')} of ${formatValue(full, 'ms')} (${pct(full > 0 ? transfer / full : 0)})` +
        `${overhead < 0 ? ', measured < 0' : ''}`,
      tooltip: `${name}, ${b.browser}: ${instances.length} instances, full ${formatValue(full, 'ms')}, transfer ` +
        `${formatValue(transfer, 'ms')} (${source(b.browser)}), ${instances.reduce((a, r) => a + r.terms, 0).toLocaleString('en')} terms`,
      heading: b.dataset === 'calibration' && !overview.some(r => r.heading) ?
        'Reference: the calibration scans (plain scans, so almost all of their time is transfer by construction)' : undefined,
    });
    overviewCsv.push([ b.dataset, b.browser, instances.length, instances.reduce((a, r) => a + r.rows, 0),
      instances.reduce((a, r) => a + r.terms, 0), round(full, 3), round(full - transfer, 3), round(transfer, 3),
      round(full > 0 ? transfer / full : 0, 5), options.overhead === 'calibrated' ? round(rate, 4) : '' ]);
  }
  if (overview.length > 0) {
    const rates = [ ...new Set(entries.map(b => b.browser)) ].filter(rateOf)
      .map(browser => `${browser} ${rateOf(browser)!.toFixed(2)} µs`).join(', ');
    write(join(dir, `plot_oxigraph_split${suffix}.svg`), splitChart({
      title: 'Oxigraph: share of the query time spent on WASM → JS transfer, per dataset',
      subtitle: `Totals over the SELECT instances that ran all four breakdown variants. Bar: Oxigraph's full time ` +
        `(what the timing runs measure) split into evaluation and transfer; transfer ${options.overhead === 'calibrated' ?
          `estimated as result terms × the cost per term fitted on the calibration scans (${rates})` :
          'measured as full − count, summed over the instances'}. Label: transfer of the total. The totals differ by ` +
        `orders of magnitude between datasets, so only the shares share an axis. ${machine}`,
      legend: [ 'evaluation', `WASM → JS transfer (${options.overhead === 'calibrated' ? 'estimated' : 'measured'})` ],
      rows: overview,
      panels: [ 'share' ],
    }));
    writeCsv(join(dir, `oxigraph_split${suffix}.csv`), [ 'dataset', 'browser', 'instances', 'results', 'terms', 'full_ms',
      'evaluation_ms', 'transfer_ms', 'transfer_share', 'us_per_term' ], overviewCsv);
    written.push(relative(ROOT, join(dir, `oxigraph_split${suffix}.csv`)));
  }
  if (options.overhead === 'calibrated') {
    for (const browser of new Set(entries.map(b => b.browser))) {
      if (rateOf(browser)) {
        written.push(...renderTop(dir, summary, browser, rateOf(browser)!, options.top ?? 5));
      }
    }
  }
  return written;
}

interface CompareRow {
  label: string;
  sublabel: string;
  comunica: number | null;
  comunicaText: string;
  oxigraph: number;
  transfer: number;
  oxigraphText: string;
  tooltip: string;
}

/**
 * Per row a Comunica bar and an Oxigraph bar split into evaluation and transfer. Consecutive rows whose longest bar is
 * within 10× of each other share a panel with a linear axis; other rows start a new panel with its own axis.
 */
function compareChart(spec: { title: string; subtitle: string; rows: CompareRow[] }): string {
  const width = 960;
  const margin = 24;
  const barH = 10;
  const pitch = 46;
  const left = margin + Math.max(...spec.rows.map(r => Math.max(r.label.length * 7, r.sublabel.length * 5.6))) + 14;
  const textRoom = Math.max(...spec.rows.map(r => Math.max(r.comunicaText.length, r.oxigraphText.length))) * 6.1 + 12;
  const plotW = width - left - margin - textRoom;
  const peak = (r: CompareRow) => Math.max(r.oxigraph, r.comunica ?? 0);
  const panels: CompareRow[][] = [];
  for (const row of spec.rows) {
    const last = panels.at(-1);
    const peaks = [ ...last?.map(peak) ?? [], peak(row) ];
    if (last && Math.max(...peaks) / Math.min(...peaks) <= 10) {
      last.push(row);
    } else {
      panels.push([ row ]);
    }
  }

  const subtitle = wrap(spec.subtitle, Math.floor((width - 2 * margin) / 6.3));
  const legendY = 46 + subtitle.length * 16;
  const out: string[] = [];
  let lx = margin;
  ENGINE_PALETTE.forEach((p, i) => {
    out.push(`<rect class="s${i}" x="${lx}" y="${legendY}" width="12" height="12" rx="3"/>`);
    out.push(`<text class="ink2" x="${lx + 17}" y="${legendY + 10.5}" font-size="12">${esc(p.label)}</text>`);
    lx += 17 + p.label.length * 6.6 + 22;
  });
  let y = legendY + 36;
  panels.forEach((panel, pi) => {
    const maxV = Math.max(...panel.map(peak));
    const step = niceStep(maxV / 4);
    const hi = Math.ceil(maxV / step) * step;
    const sx = (v: number) => (v / hi) * plotW;
    const top = y;
    const bottom = top + panel.length * pitch;
    if (pi > 0) {
      out.push(`<line class="axis" x1="${margin}" x2="${width - margin}" y1="${top - 14}" y2="${top - 14}" stroke-width="1"/>`);
    }
    for (let i = 0; i <= Math.round(hi / step); i++) {
      const v = Number((i * step).toPrecision(6));
      const x = left + sx(v);
      out.push(`<line class="grid" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${bottom}" stroke-width="1"/>`);
      out.push(`<text class="muted" x="${x.toFixed(1)}" y="${bottom + 14}" font-size="11" text-anchor="middle">${tickLabel(v, 'ms')}</text>`);
    }
    out.push(`<line class="axis" x1="${left}" x2="${left}" y1="${top}" y2="${bottom}" stroke-width="1"/>`);
    panel.forEach((row, i) => {
      const ry = top + i * pitch + 8;
      const transfer = Math.min(Math.max(row.transfer, 0), row.oxigraph);
      out.push(`<g><title>${esc(row.tooltip)}</title>`);
      out.push(`<rect x="${margin}" y="${ry - 6}" width="${width - 2 * margin}" height="${pitch - 4}" fill="transparent"/>`);
      out.push(`<text class="ink" x="${left - 12}" y="${ry + 10}" font-size="12" font-weight="600" text-anchor="end">${esc(row.label)}</text>`);
      out.push(`<text class="muted" x="${left - 12}" y="${ry + 25}" font-size="10.5" text-anchor="end">${esc(row.sublabel)}</text>`);
      if (row.comunica === null) {
        out.push(`<text class="ink2 halo" x="${left + 6}" y="${ry + 9}" font-size="11">${esc(row.comunicaText)}</text>`);
      } else {
        out.push(bar('s0', left, ry, Math.max(sx(row.comunica), 1), barH, true));
        out.push(`<text class="ink2 halo" x="${(left + Math.max(sx(row.comunica), 1) + 6).toFixed(1)}" y="${ry + 9}" font-size="11">${esc(row.comunicaText)}</text>`);
      }
      const oy = ry + barH + 4;
      out.push(...stack(left, oy, barH, sx(row.oxigraph - transfer), sx(transfer), [ 's1', 's2' ]));
      out.push(`<text class="ink2 halo" x="${(left + Math.max(sx(row.oxigraph), 1) + 6).toFixed(1)}" y="${oy + 9}" font-size="11">${esc(row.oxigraphText)}</text>`);
      out.push('</g>');
    });
    y = bottom + 44;
  });
  const height = y - 14;
  const head = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(spec.title)}">`,
    `<style>${style(ENGINE_PALETTE)}${HALO}</style>`,
    `<rect class="surface" width="${width}" height="${height}" rx="6"/>`,
    `<text class="ink" x="${margin}" y="26" font-size="16" font-weight="600">${esc(spec.title)}</text>`,
    ...subtitle.map((line, i) => `<text class="ink2" x="${margin}" y="${46 + i * 16}" font-size="12">${esc(line)}</text>`),
  ];
  return `${[ ...head, ...out, '</svg>' ].join('\n')}\n`;
}

const count = (x: number) => Number.isInteger(x) ? x.toLocaleString('en') : x.toLocaleString('en', { maximumFractionDigits: 1 });

/**
 * The templates with the largest estimated transfer, in ms and as a share of Oxigraph's time (top `n` of each, over all
 * datasets), with both engines' warm means from the timing runs: `plot_oxigraph_split_top_<browser>.svg` and its CSV.
 */
function renderTop(dir: string, summary: any, browser: string, rate: number, n: number): string[] {
  interface Candidate {
    dataset: string; template: string; instances: number; total: number; comunicaOk: number; comunica: number | null;
    comunicaOutcome: string; oxigraph: number; transfer: number; results: number; terms: number; measured: number;
  }
  const candidates: Candidate[] = [];
  for (const dataset of DATASETS) {
    const raw = readBreakdownRaw(dir, dataset, browser);
    if (!raw) {
      continue;
    }
    const stats = (engine: string) => new Map(instanceStats(readTimingRaws(dir, dataset, browser, engine), dataset, 'timing')
      .map(s => [ s.query, s ]));
    const ox = stats('oxigraph');
    const co = stats('comunica');
    // SELECT instances with all four breakdown variants (as in the split charts) that Oxigraph answered in the timing runs.
    const instances = breakdownInstances(raw, dataset)
      .filter(r => VARIANTS.every(v => typeof r[v] === 'number') && ox.get(r.query)?.outcome === 'ok');
    for (const template of new Set(instances.map(r => r.template))) {
      const of = instances.filter(r => r.template === template);
      // Both engines over the same instances: those Comunica answered too, if any.
      const both = of.filter(r => co.get(r.query)?.outcome === 'ok');
      const use = both.length > 0 ? both : of;
      candidates.push({
        dataset,
        template,
        instances: use.length,
        total: of.length,
        comunicaOk: both.length,
        comunica: both.length > 0 ? mean(both.map(r => co.get(r.query)!.mean!)) : null,
        comunicaOutcome: [ ...new Set(of.map(r => co.get(r.query)?.outcome ?? 'not run')) ].join(', '),
        oxigraph: mean(use.map(r => ox.get(r.query)!.mean!)),
        transfer: mean(use.map(r => r.terms * rate / 1000)),
        results: mean(use.map(r => r.rows)),
        terms: mean(use.map(r => r.terms)),
        measured: mean(use.map(r => r.full - r.count)),
      });
    }
  }
  if (candidates.length === 0) {
    return [];
  }
  const share = (c: Candidate) => c.transfer / c.oxigraph;
  const byMs = [ ...candidates ].sort((a, b) => b.transfer - a.transfer).slice(0, n);
  const byShare = [ ...candidates ].sort((a, b) => share(b) - share(a)).slice(0, n);
  const selected = [ ...new Set([ ...byMs, ...byShare ]) ].sort((a, b) => b.transfer - a.transfer);
  const reason = (c: Candidate) => [ byMs.includes(c) ? 'ms' : '', byShare.includes(c) ? 'share' : '' ].filter(Boolean).join('+');
  const version = Object.values<any>(summary.breakdown).find(b => b.browser === browser)?.browserVersion ?? '';
  const file = join(dir, `plot_oxigraph_split_top_${browser}.svg`);
  writeFileSync(file, compareChart({
    title: `Queries with the most WASM → JS transfer in Oxigraph, with Comunica, ${browser} ${version}`.trim(),
    subtitle: `The ${n} templates with the largest estimated transfer in ms and the ${n} with the largest share of ` +
      `Oxigraph's time, over all datasets (SELECT queries with breakdown data). Times: warm means from the timing runs, ` +
      `averaged over the template's instances that both engines answered. Transfer: result terms × ${rate.toFixed(2)} µs ` +
      `(calibration fit in ${browser}); evaluation: the rest of Oxigraph's time. Each panel has its own linear scale. ` +
      `${summary.meta?.machine?.label ?? ''}`,
    rows: selected.map(c => ({
      label: `${c.dataset} ${c.template}`,
      sublabel: `per query${Number.isInteger(c.results) && Number.isInteger(c.terms) ? '' : ' (mean)'}: ${count(c.results)} results, ${count(c.terms)} terms${c.instances < c.total ? ` (${c.instances}/${c.total} instances)` : ''}`,
      comunica: c.comunica,
      comunicaText: c.comunica === null ? `Comunica: ${c.comunicaOutcome}` : `Comunica ${formatValue(c.comunica, 'ms')}`,
      oxigraph: c.oxigraph,
      transfer: c.transfer,
      oxigraphText: `Oxigraph ${formatValue(c.oxigraph, 'ms')}, of which transfer ${formatValue(c.transfer, 'ms')} ` +
        `(${pct(share(c))})`,
      tooltip: `${c.dataset} ${c.template}, ${c.instances} instance(s): Comunica ${c.comunica === null ? c.comunicaOutcome : formatValue(c.comunica, 'ms')}; ` +
        `Oxigraph ${formatValue(c.oxigraph, 'ms')} = evaluation ${formatValue(c.oxigraph - c.transfer, 'ms')} + transfer ` +
        `${formatValue(c.transfer, 'ms')} (estimated); breakdown run, measured full − count ${formatValue(Math.abs(c.measured), 'ms')}` +
        `${c.measured < 0 ? ' below zero' : ''}; selected by ${reason(c)}`,
    })),
  }));
  const csvFile = join(dir, `oxigraph_split_top_${browser}.csv`);
  writeCsv(csvFile, [ 'dataset', 'template', 'instances', 'results', 'terms', 'comunica_ms', 'oxigraph_ms',
    'oxigraph_evaluation_ms', 'transfer_ms', 'transfer_share', 'measured_full_minus_count_ms', 'selected_by' ],
  selected.map(c => [ c.dataset, c.template, c.instances, round(c.results, 1), round(c.terms, 1),
    c.comunica === null ? c.comunicaOutcome : round(c.comunica, 4), round(c.oxigraph, 4), round(c.oxigraph - c.transfer, 4),
    round(c.transfer, 4), round(share(c), 4), round(c.measured, 4), reason(c) ]));
  return [ relative(ROOT, file), relative(ROOT, csvFile) ];
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { overhead: { type: 'string', default: 'calibrated' }, browsers: { type: 'string' }, top: { type: 'string', default: '5' } },
  });
  if (values.overhead !== 'calibrated' && values.overhead !== 'measured') {
    throw new Error(`--overhead must be calibrated or measured, not ${values.overhead}`);
  }
  const dir = resultsDir(positionals[0]);
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const written = renderSplit(dir, summary, { overhead: values.overhead, browsers: values.browsers?.split(','), top: Number(values.top) });
  console.log(`Wrote ${written.length} files:\n  ${written.join('\n  ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
