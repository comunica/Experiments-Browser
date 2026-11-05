// Warm-up experiment (`npm run bench -- --mode warmup`): every configuration runs each query cold, then for
// `--curve-rounds` recorded rounds without warmup, in a fresh browser per repetition. This script shows how query
// times converge over those rounds, and how much bias and run-to-run noise a measurement with w warm-up rounds and
// T timed rounds keeps:
// - plot_warmup.svg: per browser, a typical query's time per round relative to its plateau, per engine.
// - plot_warmup_datasets.svg: the same per dataset and browser.
// - plot_warmup_protocol.svg: for w warm-up rounds followed by T timed rounds, the bias of the warm mean against
//   the plateau, and the noise of an A/A comparison between two fresh-browser runs of the same build.
// Every run (repetition) is compared with its own plateau, its last 10 rounds: the curves divide each round by their
// median, the bias divides a warm mean by their mean (like with like: a mean over rounds is above their median even
// without any warm-up, because of occasional slow rounds). A typical query is the geometric mean over queries and
// repetitions. Queries with a median under 0.05 ms are left out (timer resolution).
// Usage: npm run plot:warmup [-- results/<dir>] [--timed 5]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BROWSERS, median, resultsDir, round, writeCsv } from './aggregate';
import { esc, SERIES, style, wrap } from './plot-common';

const ROOT = resolve(import.meta.dirname, '..');
const DATASET_ORDER = [ 'watdiv-1', 'watdiv-10', 'bsbm-100', 'bsbm-1k' ];
// The browsers, then Node (npm run bench:node) as a reference on V8 outside a browser.
const ENVIRONMENTS = [ ...BROWSERS, 'node' ];
const ENGINE_ORDER = SERIES.map(s => s.key);
const PLATEAU_ROUNDS = 10;
const MIN_PLATEAU_MS = 0.05;

const { values, positionals } = parseArgs({ allowPositionals: true, options: { timed: { type: 'string', default: '5' } } });
const TIMED = Number(values.timed);

interface Config {
  dataset: string;
  browser: string;
  engine: string;
  browserVersion: string;
  /** Per repetition: query → times by round, index 0 = cold. */
  reps: Map<string, number[]>[];
  /** Query → plateau time. */
  plateau: Map<string, number>;
  excluded: number;
}

const geomean = (xs: number[]) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

function load(dir: string): { configs: Config[]; rounds: number } {
  const raws = readdirSync(join(dir, 'raw')).filter(f => f.startsWith('warmup-') && f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, 'raw', f), 'utf8')));
  if (raws.length === 0) {
    throw new Error(`No warmup-*.json in ${dir}/raw; run npm run bench -- --mode warmup first`);
  }
  const rounds = Math.min(...raws.map(r => r.settings.rounds));
  const byKey = new Map<string, Config>();
  for (const raw of raws) {
    const key = `${raw.dataset}/${raw.browser.name}/${raw.engine.name}`;
    const config = byKey.get(key) ?? { dataset: raw.dataset, browser: raw.browser.name, engine: raw.engine.name,
      browserVersion: raw.browser.version, reps: [], plateau: new Map(), excluded: 0 };
    byKey.set(key, config);
    const times = new Map<string, number[]>();
    for (const e of raw.executions) {
      if (e.outcome !== 'ok' || (e.phase !== 'cold' && e.phase !== 'timed') || e.round > rounds) {
        continue;
      }
      const t = times.get(e.query) ?? Array.from<number>({ length: rounds + 1 }).fill(Number.NaN);
      t[e.phase === 'cold' ? 0 : e.round] = e.ms;
      times.set(e.query, t);
    }
    config.reps.push(times);
  }
  for (const config of byKey.values()) {
    // Only queries with every round ok in every repetition.
    const queries = [ ...config.reps[0].keys() ]
      .filter(q => config.reps.every(rep => rep.get(q)?.every(t => Number.isFinite(t) && t > 0)));
    for (const q of queries) {
      const p = median(config.reps.flatMap(rep => rep.get(q)!.slice(rounds + 1 - PLATEAU_ROUNDS)))!;
      if (p >= MIN_PLATEAU_MS) {
        config.plateau.set(q, p);
      } else {
        config.excluded++;
      }
    }
  }
  const configs = [ ...byKey.values() ].sort((a, b) => DATASET_ORDER.indexOf(a.dataset) - DATASET_ORDER.indexOf(b.dataset) ||
    ENVIRONMENTS.indexOf(a.browser) - ENVIRONMENTS.indexOf(b.browser) || ENGINE_ORDER.indexOf(a.engine) - ENGINE_ORDER.indexOf(b.engine));
  return { configs, rounds };
}

/** The last PLATEAU_ROUNDS rounds of a run of a query. */
const tail = (times: number[]) => times.slice(times.length - PLATEAU_ROUNDS);

/** Time per round relative to the median of the same run's plateau, as the geometric mean over queries and runs. */
function curve(configs: Config[], rounds: number): number[] {
  return Array.from({ length: rounds + 1 }, (_, k) => geomean(configs.flatMap(c =>
    c.reps.flatMap(rep => [ ...c.plateau.keys() ].map((q) => {
      const times = rep.get(q)!;
      return times[k] / median(tail(times))!;
    })))));
}

/**
 * Measuring with `w` warm-up rounds, then `timed` rounds: the bias of the warm mean against the plateau (geometric
 * mean over queries and repetitions, minus 1), and the noise of an A/A comparison between two repetitions (each a
 * fresh browser): exp(mean |log of the geometric mean over queries of the ratio of warm means|) - 1, over all pairs.
 */
function protocol(configs: Config[], w: number, timed: number): { bias: number; noise: number } {
  const warmMean = (rep: Map<string, number[]>, q: string) => mean(rep.get(q)!.slice(w + 1, w + 1 + timed));
  const ratios: number[] = [];
  const logs: number[] = [];
  for (const c of configs) {
    for (const rep of c.reps) {
      ratios.push(...[ ...c.plateau.keys() ].map(q => warmMean(rep, q) / mean(tail(rep.get(q)!))));
    }
    for (let a = 0; a < c.reps.length; a++) {
      for (let b = a + 1; b < c.reps.length; b++) {
        logs.push(Math.abs(Math.log(geomean([ ...c.plateau.keys() ].map(q => warmMean(c.reps[b], q) / warmMean(c.reps[a], q))))));
      }
    }
  }
  // Without two repetitions of a configuration there is no A/A comparison.
  return { bias: geomean(ratios) - 1, noise: logs.length > 0 ? Math.exp(mean(logs)) - 1 : Number.NaN };
}

interface Line {
  key: string;
  label: string;
  dashed?: boolean;
  points: { x: number; y: number; tip: string }[];
}

interface Panel {
  label: string;
  lines: Line[];
}

/**
 * Line charts in a grid of panels that share their axes. y is logarithmic when yLog (values are ratios around 1) or
 * linear from 0. A dashed reference line at yRef.
 */
function linePanels(spec: {
  title: string; subtitle: string; panels: Panel[]; cols: number; xLabel: string; yLabel: string; yLog: boolean;
  yTicks: number[]; yFormat: (v: number) => string; xTicks: number[]; xFormat: (v: number) => string; yRef?: number;
  legend: { key: string; label: string; dashed?: boolean }[];
}): string {
  const width = 960;
  const margin = 24;
  const left = 64;
  const gap = 28;
  const rows = Math.ceil(spec.panels.length / spec.cols);
  const panelW = (width - left - margin - (spec.cols - 1) * gap) / spec.cols;
  const panelH = rows > 1 ? 150 : 260;
  const subtitle = wrap(spec.subtitle, Math.floor((width - 2 * margin) / 6.3));
  const legendY = 46 + subtitle.length * 16;
  const top = legendY + 44;
  const rowGap = 46;
  const height = top + rows * panelH + (rows - 1) * rowGap + 50;
  const all = spec.panels.flatMap(p => p.lines.flatMap(l => l.points)).filter(p => Number.isFinite(p.y));
  const xs = all.map(p => p.x);
  const [ xMin, xMax ] = [ Math.min(...xs), Math.max(...xs) ];
  const [ yMin, yMax ] = [ Math.min(...spec.yTicks), Math.max(...spec.yTicks) ];
  const fy = (v: number) => spec.yLog ? (Math.log(v) - Math.log(yMin)) / (Math.log(yMax) - Math.log(yMin)) : (v - yMin) / (yMax - yMin);
  const palette = SERIES.filter(s => spec.legend.some(l => l.key === s.key));
  const cls = (key: string) => `so${palette.findIndex(s => s.key === key)}`;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(spec.title)}">`);
  out.push(`<style>${style(palette)}</style>`);
  out.push(`<rect class="surface" width="${width}" height="${height}" rx="6"/>`);
  out.push(`<text class="ink" x="${margin}" y="26" font-size="16" font-weight="600">${esc(spec.title)}</text>`);
  subtitle.forEach((line, i) => out.push(`<text class="ink2" x="${margin}" y="${46 + i * 16}" font-size="12">${esc(line)}</text>`));
  let lx = margin;
  for (const item of spec.legend) {
    out.push(`<line class="${cls(item.key)}" x1="${lx}" x2="${lx + 18}" y1="${legendY + 6}" y2="${legendY + 6}" stroke-width="2.5"${item.dashed ? ' stroke-dasharray="5 3"' : ''}/>`);
    out.push(`<text class="ink2" x="${lx + 24}" y="${legendY + 10.5}" font-size="12">${esc(item.label)}</text>`);
    lx += 24 + item.label.length * 6.6 + 22;
  }
  spec.panels.forEach((panel, i) => {
    const col = i % spec.cols;
    const row = Math.floor(i / spec.cols);
    const x0 = left + col * (panelW + gap);
    const y0 = top + row * (panelH + rowGap);
    const px = (v: number) => x0 + ((v - xMin) / (xMax - xMin || 1)) * panelW;
    const py = (v: number) => y0 + panelH - Math.min(Math.max(fy(v), -0.02), 1.02) * panelH;
    out.push(`<text class="ink" x="${x0}" y="${y0 - 10}" font-size="12" font-weight="600">${esc(panel.label)}</text>`);
    for (const t of thin(spec.yTicks, py, spec.yRef)) {
      out.push(`<line class="grid" x1="${x0}" x2="${x0 + panelW}" y1="${py(t).toFixed(1)}" y2="${py(t).toFixed(1)}" stroke-width="1"/>`);
      if (col === 0) {
        out.push(`<text class="muted" x="${x0 - 8}" y="${(py(t) + 4).toFixed(1)}" font-size="11" text-anchor="end">${esc(spec.yFormat(t))}</text>`);
      }
    }
    for (const t of spec.xTicks) {
      out.push(`<text class="muted" x="${px(t).toFixed(1)}" y="${y0 + panelH + 15}" font-size="11" text-anchor="middle">${esc(spec.xFormat(t))}</text>`);
    }
    out.push(`<line class="axis" x1="${x0}" x2="${x0 + panelW}" y1="${y0 + panelH}" y2="${y0 + panelH}" stroke-width="1"/>`);
    if (spec.yRef !== undefined) {
      out.push(`<line class="whisker" x1="${x0}" x2="${x0 + panelW}" y1="${py(spec.yRef).toFixed(1)}" y2="${py(spec.yRef).toFixed(1)}" stroke-width="1" stroke-dasharray="3 3"/>`);
    }
    for (const line of panel.lines.map(l => ({ ...l, points: l.points.filter(p => Number.isFinite(p.y)) }))) {
      if (line.points.length === 0) {
        continue;
      }
      const d = line.points.map((p, j) => `${j === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)} ${py(p.y).toFixed(1)}`).join(' ');
      out.push(`<path class="${cls(line.key)}" d="${d}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${line.dashed ? ' stroke-dasharray="5 3"' : ''}/>`);
      for (const p of line.points) {
        out.push(`<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="5" fill="transparent"><title>${esc(`${panel.label}, ${line.label}: ${p.tip}`)}</title></circle>`);
      }
    }
    if (row === rows - 1) {
      out.push(`<text class="ink2" x="${(x0 + panelW / 2).toFixed(1)}" y="${y0 + panelH + 34}" font-size="12" text-anchor="middle">${esc(spec.xLabel)}</text>`);
    }
  });
  out.push(`<text class="ink2" transform="translate(16 ${(top + (height - 50 - top) / 2).toFixed(1)}) rotate(-90)" font-size="12" text-anchor="middle">${esc(spec.yLabel)}</text>`);
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

/** Ticks at least 14 px apart, kept outwards from the reference value (or the lowest tick). */
function thin(ticks: number[], py: (v: number) => number, ref?: number): number[] {
  const sorted = [ ...ticks ].sort((a, b) => a - b);
  const start = ref !== undefined && sorted.includes(ref) ? sorted.indexOf(ref) : 0;
  const kept = [ sorted[start] ];
  for (const direction of [ 1, -1 ]) {
    let last = sorted[start];
    for (let i = start + direction; i >= 0 && i < sorted.length; i += direction) {
      if (Math.abs(py(sorted[i]) - py(last)) >= 14) {
        kept.push(sorted[i]);
        last = sorted[i];
      }
    }
  }
  return kept;
}

/** Ticks for a log axis of ratios that covers [lo, hi]. */
function ratioTicks(lo: number, hi: number): number[] {
  const candidates = [ 0.5, 0.67, 0.8, 0.9, 0.95, 1, 1.05, 1.1, 1.25, 1.5, 2, 2.5, 3, 4, 5 ];
  const below = candidates.filter(t => t <= lo).at(-1) ?? candidates[0];
  const above = candidates.find(t => t >= hi) ?? candidates.at(-1)!;
  return candidates.filter(t => t >= below && t <= above);
}

function main(): void {
  const dir = resultsDir(positionals[0]);
  const { configs, rounds } = load(dir);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const machine = meta.machine?.label ?? '';
  const build = `Comunica ${meta.comunica?.commit?.slice(0, 7) ?? '?'} (rdf-stores ${meta.versions?.rdfStores ?? '?'}), Oxigraph ${meta.versions?.oxigraph ?? '?'}`;
  const browsers = ENVIRONMENTS.filter(b => configs.some(c => c.browser === b));
  const engines = ENGINE_ORDER.filter(e => configs.some(c => c.engine === e));
  const datasets = DATASET_ORDER.filter(d => configs.some(c => c.dataset === d));
  const reps = Math.max(...configs.map(c => c.reps.length));
  const label = (e: string) => SERIES.find(s => s.key === e)!.label;
  const written: string[] = [];
  const write = (file: string, svg: string) => {
    writeFileSync(file, svg);
    written.push(relative(ROOT, file));
  };
  const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(100 * x).toFixed(1)} %`;
  const xTicks = [ 0, ...Array.from({ length: Math.floor(rounds / 5) }, (_, i) => (i + 1) * 5) ];
  const xFormat = (v: number) => v === 0 ? 'cold' : String(v);
  const legend = engines.map(e => ({ key: e, label: label(e) }));

  // Curves per browser (all datasets) and per dataset and browser.
  const curveCsv: (string | number)[][] = [];
  const curvePanels = (groups: { label: string; filter: (c: Config) => boolean; csv: string }[]) => groups.map(g => ({
    label: g.label,
    lines: engines.map((e) => {
      const selected = configs.filter(c => g.filter(c) && c.engine === e);
      const values = curve(selected, rounds);
      values.forEach((v, k) => curveCsv.push([ g.csv, e, k, round(v, 4) ]));
      return { key: e, label: label(e), points: values.map((v, k) => ({ x: k, y: v,
        tip: `${k === 0 ? 'cold run' : `round ${k}`}: ${v.toFixed(3)} × plateau` })) };
    }),
  }));
  const byBrowser = curvePanels(browsers.map(b => ({ label: `${b} ${configs.find(c => c.browser === b)!.browserVersion}`,
    filter: (c: Config) => c.browser === b, csv: `all/${b}` })));
  const byDataset = curvePanels(datasets.flatMap(d => browsers.map(b => ({ label: `${d}, ${b}`,
    filter: (c: Config) => c.dataset === d && c.browser === b, csv: `${d}/${b}` }))));
  const span = (panels: Panel[]) => panels.flatMap(p => p.lines.flatMap(l => l.points.map(q => q.y)));
  const queries = (e: string) => configs.filter(c => c.engine === e && c.browser === browsers[0]).reduce((a, c) => a + c.plateau.size, 0);
  const excluded = configs.reduce((a, c) => a + c.excluded, 0);
  const common = `${reps} repetitions per configuration, each in a fresh browser: every query once cold, then ${rounds} ` +
    `recorded rounds without warmup. y: time of a typical query (geometric mean over queries and repetitions) relative ` +
    `to the median of the same run's last ${PLATEAU_ROUNDS} rounds; log scale.`;
  write(join(dir, 'plot_warmup.svg'), linePanels({
    title: 'Query time over the rounds after the cold run',
    subtitle: `${common} ${datasets.join(', ')} together (${engines.map(e => `${label(e)} ${queries(e)} queries`).join(', ')}` +
      `${excluded > 0 ? `; ${excluded} query/configuration pairs under ${MIN_PLATEAU_MS} ms left out` : ''}). ${build}. ${machine}`,
    panels: byBrowser,
    cols: browsers.length,
    xLabel: 'round after the cold run',
    yLabel: 'time ÷ plateau',
    yLog: true,
    yTicks: ratioTicks(Math.min(...span(byBrowser)), Math.max(...span(byBrowser))),
    yFormat: v => `${v}×`,
    xTicks,
    xFormat,
    yRef: 1,
    legend,
  }));
  write(join(dir, 'plot_warmup_datasets.svg'), linePanels({
    title: 'Query time over the rounds after the cold run, per dataset',
    subtitle: `${common} ${build}. ${machine}`,
    panels: byDataset,
    cols: browsers.length,
    xLabel: 'round after the cold run',
    yLabel: 'time ÷ plateau',
    yLog: true,
    yTicks: ratioTicks(Math.min(...span(byDataset)), Math.max(...span(byDataset))),
    yFormat: v => `${v}×`,
    xTicks,
    xFormat,
    yRef: 1,
    legend,
  }));
  writeCsv(join(dir, 'warmup_curves.csv'), [ 'group', 'engine', 'round', 'time_over_plateau' ], curveCsv);
  written.push(relative(ROOT, join(dir, 'warmup_curves.csv')));

  // Protocol: w warm-up rounds, then TIMED timed rounds. w stays clear of the rounds that define the plateau.
  const maxW = rounds - PLATEAU_ROUNDS - TIMED;
  const ws = Array.from({ length: maxW + 1 }, (_, i) => i);
  const protocolCsv: (string | number)[][] = [];
  const protocolPanels: Panel[] = [];
  for (const metric of [ 'bias', 'noise' ] as const) {
    for (const b of browsers) {
      protocolPanels.push({
        label: `${metric === 'bias' ? 'Bias against the plateau' : 'A/A noise'}, ${b}`,
        lines: engines.map((e) => {
          const selected = configs.filter(c => c.browser === b && c.engine === e);
          return { key: e, label: label(e), points: ws.map((w) => {
            const r = protocol(selected, w, TIMED);
            if (metric === 'bias') {
              protocolCsv.push([ b, e, w, TIMED, round(r.bias, 4), round(r.noise, 4) ]);
            }
            return { x: w, y: 100 * r[metric], tip: `${w} warm-up rounds: ${metric} ${pct(r[metric])}` };
          }) };
        }),
      });
    }
  }
  const ys = protocolPanels.flatMap(p => p.lines.flatMap(l => l.points.map(q => q.y))).filter(Number.isFinite);
  const yMax = Math.max(...ys);
  const step = yMax - Math.min(0, ...ys) > 20 ? 10 : yMax - Math.min(0, ...ys) > 8 ? 5 : 2;
  const yLow = Math.floor(Math.min(0, ...ys) / step) * step;
  write(join(dir, 'plot_warmup_protocol.svg'), linePanels({
    title: `What w warm-up rounds before ${TIMED} timed rounds leave: bias and noise`,
    subtitle: `Top: how much the warm mean (mean of the ${TIMED} timed rounds) of a typical query exceeds the mean of ` +
      `the same run's last ${PLATEAU_ROUNDS} rounds. ` +
      `Bottom: noise of an A/A comparison, two runs of the same build in separate fresh browsers: the typical ` +
      `absolute difference of the geometric mean over queries of the ratio of their warm means, over all pairs of ` +
      `the ${reps} repetitions and the datasets ${datasets.join(', ')}. The current setting is 1 warm-up round ` +
      `(after the cold run). ${build}. ${machine}`,
    panels: protocolPanels,
    cols: browsers.length,
    xLabel: 'warm-up rounds after the cold run',
    yLabel: '%',
    yLog: false,
    yTicks: Array.from({ length: Math.round((Math.ceil(yMax / step) * step - yLow) / step) + 1 }, (_, i) => yLow + i * step),
    yFormat: v => `${v} %`,
    xTicks: ws.filter(w => w % 5 === 0 || w === 1),
    xFormat: v => String(v),
    yRef: 0,
    legend,
  }));
  writeCsv(join(dir, 'warmup_protocol.csv'), [ 'browser', 'engine', 'warmup_rounds', 'timed_rounds', 'bias', 'aa_noise' ], protocolCsv);
  written.push(relative(ROOT, join(dir, 'warmup_protocol.csv')));

  // Summary on stdout: bias and noise for a few settings.
  console.log(`Warm-up protocol (${TIMED} timed rounds): bias / A/A noise`);
  console.log(`${'browser'.padEnd(10)}${'engine'.padEnd(10)}${[ 0, 1, 2, 3, 5, 10, maxW ].filter((w, i, a) => w <= maxW && a.indexOf(w) === i).map(w => `w=${w}`.padStart(17)).join('')}`);
  for (const b of browsers) {
    for (const e of engines) {
      const selected = configs.filter(c => c.browser === b && c.engine === e);
      console.log(`${b.padEnd(10)}${e.padEnd(10)}${[ 0, 1, 2, 3, 5, 10, maxW ].filter((w, i, a) => w <= maxW && a.indexOf(w) === i)
        .map((w) => {
          const r = protocol(selected, w, TIMED);
          return `${pct(r.bias)} / ${Number.isFinite(r.noise) ? `${(100 * r.noise).toFixed(1)}%` : 'n/a'}`.padStart(17);
        }).join('')}`);
    }
  }
  console.log(`Wrote ${written.length} files:\n  ${written.join('\n  ')}`);
}

main();
