// Stacked bars of Oxigraph's query time, split into evaluation and moving the results from WASM into JavaScript,
// from the breakdown runs: per dataset and browser one row per template, plus an overview with one row per dataset.
// Usage: npm run plot:split [-- results/<dir>] [--overhead calibrated|measured] [--browsers chromium,firefox]
//   calibrated (default): transfer = result terms × the per-term cost fitted on the calibration scans in that browser.
//   measured: transfer = full − count of each query, which is noisy for single queries.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BROWSERS, breakdownInstances, DATASETS, resultsDir, round, VARIANTS, writeCsv } from './aggregate';
import { esc, formatValue, mean, niceStep, readBreakdownRaw, style, tickLabel, wrap } from './plot-common';

const ROOT = resolve(import.meta.dirname, '..');

// Categorical slots 1-2, as in the breakdown charts, where slot 1 is the evaluation-only (count) variant.
const PALETTE = [
  { label: 'evaluation', light: '#2a78d6', dark: '#3987e5' },
  { label: 'WASM → JS transfer', light: '#eb6834', dark: '#d95926' },
];

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
function stack(x: number, y: number, h: number, evalW: number, transferW: number): string[] {
  if (transferW < 1) {
    return [ bar('s0', x, y, Math.max(evalW + transferW, 1), h, true) ];
  }
  if (evalW < 1) {
    return [ bar('s1', x, y, evalW + transferW, h, true) ];
  }
  return [ bar('s0', x, y, evalW - 1, h, false), bar('s1', x + evalW + 1, y, transferW - 1, h, true) ];
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
  out.push(`<style>${style(PALETTE)}</style>`);
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
      out.push(`<text class="ink2" x="${(left + Math.max(tx(row.total), 1) + 6).toFixed(1)}" y="${by + 10}" font-size="11">${esc(row.timeLabel)}</text>`);
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
export function renderSplit(dir: string, summary: any, options: { overhead: OverheadSource; browsers?: string[] }): string[] {
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
  return written;
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { overhead: { type: 'string', default: 'calibrated' }, browsers: { type: 'string' } },
  });
  if (values.overhead !== 'calibrated' && values.overhead !== 'measured') {
    throw new Error(`--overhead must be calibrated or measured, not ${values.overhead}`);
  }
  const dir = resultsDir(positionals[0]);
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const written = renderSplit(dir, summary, { overhead: values.overhead, browsers: values.browsers?.split(',') });
  console.log(`Wrote ${written.length} files:\n  ${written.join('\n  ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
