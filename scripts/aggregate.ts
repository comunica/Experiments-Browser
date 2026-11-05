// Aggregates results/<dir>/raw/*.json into CSVs (Experiments-Centralized column shape), totals, the support
// matrix, summary.json and the generated parts of results/<dir>/README.md.
// Usage: npm run aggregate [-- results/<dir>]   (defaults to the most recently modified results directory)
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
export const ENGINES = [ 'comunica', 'oxigraph' ];
export const BROWSERS = [ 'chromium', 'firefox', 'webkit' ];
export const DATASETS = [ 'watdiv-1', 'watdiv-10', 'bsbm-100', 'bsbm-1k', 'bsbm-10k', 'ldbc-snb-0.1' ];
/** Families with a single scale, whose support pass is the first timing repetition's cold pass. */
const SINGLE_SCALE = [ 'ldbc-snb-0.1' ];
const OK_LIKE = new Set([ 'ok' ]);

export function resultsDir(arg?: string): string {
  if (arg) {
    return resolve(ROOT, arg);
  }
  const base = join(ROOT, 'results');
  const dirs = readdirSync(base).filter(d => existsSync(join(base, d, 'raw')))
    .sort((a, b) => statSync(join(base, b, 'raw')).mtimeMs - statSync(join(base, a, 'raw')).mtimeMs);
  if (dirs.length === 0) {
    throw new Error('No results/<dir>/raw found');
  }
  return join(base, dirs[0]);
}

interface Exec {
  phase: string;
  round: number;
  query: string;
  outcome: string;
  ms: number | null;
  count: number | null;
  expected: number | null;
  error?: string;
}

interface Raw {
  mode: string;
  repetition?: number;
  dataset: string;
  browser: { name: string; version: string };
  engine: { name: string };
  build: any;
  status: string;
  load: any;
  memory: any;
  attempts: any[];
  executions: Exec[];
}

export interface InstanceStats {
  query: string;
  template: string;
  expected: number | null;
  outcome: string;
  count: number | null;
  error?: string;
  /** Mean of the cold executions over all repetitions. */
  cold: number | null;
  coldMin: number | null;
  coldMax: number | null;
  /** Warm statistics over the timed executions of all repetitions pooled. */
  mean: number | null;
  min: number | null;
  max: number | null;
  n: number;
}

const template = (query: string) => query.replace(/-\d+$/u, '');
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const round = (x: number | null | undefined, digits = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? '' : String(Number(x.toFixed(digits)));

function queryIds(dataset: string): string[] {
  return readdirSync(join(ROOT, 'data', dataset, 'queries')).filter(f => f.endsWith('.sparql'))
    .map(f => f.replace(/\.sparql$/u, '')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function expectedCounts(dataset: string): Record<string, number | null> {
  const file = join(ROOT, 'data', dataset, 'reference.json');
  if (!existsSync(file)) {
    return {};
  }
  const ref = JSON.parse(readFileSync(file, 'utf8'));
  return Object.fromEntries(Object.entries(ref.queries).map(([ id, v ]: [string, any]) => [ id, v.agree ? v.count : null ]));
}

/**
 * Per query instance, over all repetitions of one configuration: outcome (the first non-ok outcome of any recorded
 * execution), cold time (mean over repetitions) and warm statistics (timed executions of all repetitions pooled).
 */
export function instanceStats(raws: Raw[], dataset: string, mode: string, onlyPhase?: string): InstanceStats[] {
  const expected = expectedCounts(dataset);
  return queryIds(dataset).map((query) => {
    // Unrecorded re-warm executions count for the outcome (a timeout there is a timeout), not for the timings.
    const all = raws.flatMap(raw => raw.executions.filter(e => e.query === query && (!onlyPhase || e.phase === onlyPhase)));
    const execs = all.filter(e => e.phase !== 'rewarm');
    const firstBad = all.find(e => !OK_LIKE.has(e.outcome));
    let outcome = firstBad?.outcome ?? 'ok';
    if (raws.length === 0) {
      outcome = 'skipped';
    } else if (execs.length === 0) {
      const failed = raws.find(raw => raw.status !== 'complete');
      outcome = failed?.status === 'oom' ? 'oom' : failed ? 'error' : 'missing';
    }
    if (outcome === 'ok' && mode === 'timing' && !onlyPhase && !execs.some(e => e.phase === 'timed')) {
      outcome = 'missing';
    }
    const coldPhase = onlyPhase ?? (mode === 'support' ? 'support' : 'cold');
    const colds = execs.filter(e => e.phase === coldPhase && e.outcome === 'ok').map(e => e.ms!);
    const timed = execs.filter(e => e.phase === 'timed' && e.outcome === 'ok').map(e => e.ms!);
    return {
      query,
      template: template(query),
      expected: expected[query] ?? null,
      outcome,
      count: execs.find(e => e.count !== null)?.count ?? null,
      error: firstBad?.error,
      cold: colds.length > 0 ? mean(colds) : null,
      coldMin: colds.length > 0 ? Math.min(...colds) : null,
      coldMax: colds.length > 0 ? Math.max(...colds) : null,
      mean: timed.length > 0 ? mean(timed) : null,
      min: timed.length > 0 ? Math.min(...timed) : null,
      max: timed.length > 0 ? Math.max(...timed) : null,
      n: timed.length,
    };
  });
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) {
    return null;
  }
  const sorted = [ ...xs ].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median, min and max over repetitions of a per-run value. */
function spread(values: (number | null | undefined)[]): { median: number | null; min: number | null; max: number | null } {
  const xs = values.filter((x): x is number => typeof x === 'number');
  return { median: median(xs), min: xs.length > 0 ? Math.min(...xs) : null, max: xs.length > 0 ? Math.max(...xs) : null };
}

export function writeCsv(file: string, header: string[], rows: (string | number)[][]): void {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, `${[ header, ...rows ].map(r => r.join(';')).join('\n')}\n`);
}

function main(): void {
  const dir = resultsDir(process.argv[2]);
  const raws: Raw[] = readdirSync(join(dir, 'raw')).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, 'raw', f), 'utf8')));
  const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {};
  const find = (mode: string, dataset: string, browser: string, engine: string) =>
    raws.filter(r => r.mode === mode && r.dataset === dataset && r.browser.name === browser && r.engine.name === engine);
  const browsers = BROWSERS.filter(b => raws.some(r => r.browser.name === b));
  const engines = ENGINES.filter(e => raws.some(r => r.engine.name === e));
  const summary: Record<string, any> = { dir: relative(ROOT, dir), browsers, engines, datasets: {}, support: {} };

  // Bundle sizes.
  if (existsSync(join(dir, 'bundle-sizes.json'))) {
    const sizes = JSON.parse(readFileSync(join(dir, 'bundle-sizes.json'), 'utf8'));
    writeCsv(join(dir, 'bundle-sizes.csv'),
      [ 'page', 'js_raw_bytes', 'js_gzip_bytes', 'wasm_raw_bytes', 'wasm_gzip_bytes', 'total_raw_bytes', 'total_gzip_bytes' ],
      sizes.map((s: any) => [ s.page, s.jsRaw, s.jsGzip, s.wasmRaw, s.wasmGzip, s.totalRaw, s.totalGzip ]));
    summary.bundleSizes = sizes;
  }

  // Support matrix: one row per query instance at the smallest scale of each family, one column per browser/engine.
  // A family with a single scale and no support pass (LDBC SNB) uses the cold pass of the first timing repetition,
  // which is the same procedure: a fresh page and one execution of every query.
  const fromCold = (d: string) => !raws.some(r => r.mode === 'support' && r.dataset === d) &&
    SINGLE_SCALE.includes(d) && raws.some(r => r.mode === 'timing' && r.dataset === d && r.repetition === 1);
  const supportDatasets = DATASETS.filter(d => raws.some(r => r.mode === 'support' && r.dataset === d) || fromCold(d));
  summary.supportFromCold = supportDatasets.filter(fromCold);
  const columns = browsers.flatMap(b => engines.map(e => `${b}/${e}`));
  const supportRows: string[][] = [];
  for (const dataset of supportDatasets) {
    const perColumn = Object.fromEntries(columns.map((c) => {
      const [ b, e ] = c.split('/');
      return [ c, fromCold(dataset) ?
        instanceStats(find('timing', dataset, b, e).filter(r => r.repetition === 1), dataset, 'timing', 'cold') :
        instanceStats(find('support', dataset, b, e), dataset, 'support') ];
    }));
    summary.support[dataset] = Object.fromEntries(columns.map(c => [ c, countOutcomes(perColumn[c]) ]));
    summary.support[dataset].nonOk = columns.flatMap(c => perColumn[c].filter(s => s.outcome !== 'ok')
      .map(s => ({ column: c, query: s.query, outcome: s.outcome, error: s.error })));
    queryIds(dataset).forEach((query, i) => {
      supportRows.push([ dataset, query, String(perColumn[columns[0]][i].expected ?? ''), ...columns.map(c => perColumn[c][i].outcome) ]);
    });
  }
  if (supportRows.length > 0) {
    writeCsv(join(dir, 'support-matrix.csv'), [ 'dataset', 'query', 'expected', ...columns ], supportRows);
  }

  // Timing runs, per dataset.
  for (const dataset of DATASETS) {
    if (!raws.some(r => r.mode === 'timing' && r.dataset === dataset)) {
      continue;
    }
    const ds: Record<string, any> = { browsers: {} };
    summary.datasets[dataset] = ds;
    const loadRows: (string | number)[][] = [];
    const totalRows: (string | number)[][] = [];
    for (const browser of browsers) {
      const stats = Object.fromEntries(engines.map(e => [ e, instanceStats(find('timing', dataset, browser, e), dataset, 'timing') ]));
      const ids = queryIds(dataset);
      const b: Record<string, any> = { engines: {} };
      ds.browsers[browser] = b;
      // Instances that both engines answered correctly in this browser.
      const common = ids.filter((_, i) => engines.every(e => stats[e][i].outcome === 'ok'));
      b.commonOk = common.length;

      // Per-instance CSV.
      writeCsv(join(dir, dataset, `instances_${browser}.csv`),
        [ 'query', 'expected', ...engines.flatMap(e => [ `${e}-outcome`, `${e}-count`, `${e}-mean`, `${e}-min`, `${e}-max`, `${e}-n`,
          `${e}-cold-mean`, `${e}-cold-min`, `${e}-cold-max` ]) ],
        ids.map((q, i) => [ q, String(stats[engines[0]][i].expected ?? ''), ...engines.flatMap((e) => {
          const s = stats[e][i];
          return [ s.outcome, String(s.count ?? ''), round(s.mean), round(s.min), round(s.max), s.n, round(s.cold), round(s.coldMin), round(s.coldMax) ];
        }) ]));

      // Per-template CSV in the Experiments-Centralized shape, over the instances that are ok for that engine.
      const templates = [ ...new Set(ids.map(template)) ];
      writeCsv(join(dir, dataset, `plot_${browser}.csv`),
        [ 'query', ...engines.flatMap(e => [ `${e}-mean`, `${e}-minus`, `${e}-plus`, `${e}-cold-mean`, `${e}-cold-minus`, `${e}-cold-plus`, `${e}-ok` ]) ],
        templates.map(t => [ t, ...engines.flatMap((e) => {
          const ok = stats[e].filter(s => s.template === t && s.outcome === 'ok');
          const warm = ok.map(s => s.mean!);
          const cold = ok.map(s => s.cold!).filter(x => x !== null);
          const agg = (xs: number[]) => xs.length === 0 ? [ '', '', '' ] : [ round(mean(xs)), round(mean(xs) - Math.min(...xs)), round(Math.max(...xs) - mean(xs)) ];
          return [ ...agg(warm), ...agg(cold), String(ok.length) ];
        }) ]));

      for (const e of engines) {
        const reps = find('timing', dataset, browser, e);
        const s = stats[e];
        const outcomes = countOutcomes(s);
        const ok = s.filter(x => x.outcome === 'ok');
        const inCommon = s.filter(x => common.includes(x.query));
        const loads = reps.map(r => r.load).filter(Boolean);
        const memories = reps.map(r => r.memory).filter(m => m?.bytes);
        const entry = {
          status: reps.length === 0 ? 'skipped' : reps.find(r => r.status !== 'complete')?.status ?? 'complete',
          repetitions: reps.length,
          browserVersion: reps[0]?.browser.version,
          comunicaCommit: reps[0]?.build?.comunica?.commit,
          outcomes,
          totalWarmMs: ok.reduce((a, x) => a + x.mean!, 0),
          totalColdMs: ok.reduce((a, x) => a + x.cold!, 0),
          commonWarmMs: inCommon.reduce((a, x) => a + x.mean!, 0),
          commonColdMs: inCommon.reduce((a, x) => a + x.cold!, 0),
          commonGeomeanWarmMs: inCommon.length > 0 ? Math.exp(mean(inCommon.map(x => Math.log(Math.max(x.mean!, 0.001))))) : null,
          slowest: [ ...s ].filter(x => x.outcome === 'ok').sort((x, y) => y.mean! - x.mean!).slice(0, 3)
            .map(x => ({ query: x.query, warmMeanMs: x.mean, warmMinMs: x.min, warmMaxMs: x.max, coldMs: x.cold })),
          failures: s.filter(x => x.outcome !== 'ok').map(x => ({ query: x.query, outcome: x.outcome, error: x.error })),
          // Per-run values: median over repetitions, with min and max.
          init: spread(loads.map(l => l.importMs + l.initMs)),
          fetchInflate: spread(loads.map(l => l.fetchMs + l.inflateMs)),
          parse: spread(loads.map(l => l.parseMs)),
          ingest: spread(loads.map(l => l.ingestMs)),
          load: spread(loads.map(l => l.loadMs)),
          loadDetails: Object.fromEntries(Object.keys(loads[0]?.details ?? {}).map(k => [ k, spread(loads.map(l => l.details[k])) ])),
          memory: spread(memories.map(m => m.bytes / 1e6)),
          memoryMethod: [ ...new Set(memories.map(m => m.method)) ].join('+') || null,
          wasmMemory: spread(memories.map(m => m.wasmBytes ? m.wasmBytes / 1e6 : null)),
          attempts: reps.map(r => r.attempts.length),
        };
        const initMs = entry.init.median;
        const loadMs = entry.load.median;
        Object.assign(entry, { initMs, loadMs, fetchInflateMs: entry.fetchInflate.median, parseMs: entry.parse.median,
          ingestMs: entry.ingest.median, memoryMB: entry.memory.median, wasmMemoryMB: entry.wasmMemory.median });
        b.engines[e] = entry;
        loadRows.push([ browser, e, entry.repetitions, round(entry.init.median), round(entry.fetchInflate.median), round(entry.parse.median),
          round(entry.ingest.median), round(entry.load.median), round(entry.load.min), round(entry.load.max),
          round(entry.memory.median), round(entry.memory.min), round(entry.memory.max), entry.memoryMethod ?? '' ]);
        totalRows.push([ browser, e, outcomes.ok ?? 0, ...[ 'wrong', 'unsupported', 'timeout', 'error', 'oom' ].map(o => outcomes[o] ?? 0),
          round(entry.totalWarmMs), round(entry.totalColdMs), common.length, round(entry.commonWarmMs), round(entry.commonColdMs),
          round(entry.commonGeomeanWarmMs, 3) ]);
      }
    }
    writeCsv(join(dir, dataset, 'plot_load.csv'),
      [ 'browser', 'engine', 'repetitions', 'init_ms', 'fetch_inflate_ms', 'parse_ms', 'ingest_ms', 'load_ms', 'load_min_ms', 'load_max_ms',
        'memory_mb', 'memory_min_mb', 'memory_max_mb', 'memory_method' ], loadRows);
    writeCsv(join(dir, dataset, 'totals.csv'),
      [ 'browser', 'engine', 'ok', 'wrong', 'unsupported', 'timeout', 'error', 'oom', 'total_warm_ms', 'total_cold_ms',
        'common_ok', 'common_warm_ms', 'common_cold_ms', 'common_geomean_warm_ms' ], totalRows);
  }

  summary.breakdown = breakdown(dir, raws.filter(r => r.mode === 'breakdown'), browsers);

  summary.meta = meta;
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  writeReadme(dir, summary);
  console.log(`Aggregated ${raws.length} raw files into ${relative(ROOT, dir)}`);
}

export const VARIANTS = [ 'count', 'objects', 'full', 'json' ];

/**
 * Oxigraph breakdown: per query instance, the mean time of each variant over the timed rounds. `count` evaluates the
 * query and returns one number; `objects` also builds the JS result objects; `full` also reads every value (what the
 * timing runs measure); `json` hands over one serialized string instead, then parses it and reads every value.
 */
export function breakdownInstances(raw: Raw, dataset: string): Record<string, any>[] {
  const preExcluded: string[] = (raw as any).breakdown?.preExcluded ?? [];
  const subset: string[] | undefined = (raw as any).querySubset;
  return queryIds(dataset).filter(query => !subset || subset.includes(query)).map((query) => {
    const execs = raw.executions.filter(e => e.query === query && e.phase !== 'rewarm');
    const row: Record<string, any> = { query, template: template(query), preExcluded: preExcluded.includes(query) };
    for (const variant of VARIANTS) {
      const runs = execs.filter(e => (e as any).variant === variant);
      const bad = runs.find(e => e.outcome !== 'ok');
      const timed = runs.filter(e => e.phase === 'timed' && e.outcome === 'ok').map(e => e.ms!);
      row[variant] = runs.length === 0 ? null : bad ? bad.outcome : timed.length > 0 ? mean(timed) : null;
    }
    const objects = execs.find(e => (e as any).variant === 'objects' && e.outcome === 'ok');
    row.rows = objects?.count ?? null;
    row.terms = (objects as any)?.terms ?? null;
    if (typeof row.full === 'number' && typeof row.count === 'number') {
      row.transfer = row.full - row.count;
      row.usPerRow = row.rows > 0 ? 1000 * row.transfer / row.rows : null;
      row.usPerTerm = row.terms > 0 ? 1000 * row.transfer / row.terms : null;
    }
    return row;
  });
}

/** Least-squares line y = intercept + slope · x. */
export function fit(points: { x: number; y: number }[]): { slope: number; intercept: number; r2: number; n: number } | null {
  if (points.length < 3) {
    return null;
  }
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const sxy = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
  const syy = points.reduce((a, p) => a + (p.y - my) ** 2, 0);
  if (sxx === 0) {
    return null;
  }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy), n };
}

/**
 * Overhead per result of moving Oxigraph's results into JavaScript, over the instances that have all four variants:
 * the total overhead divided by the total number of results, the median over instances with results, and a fit of
 * overhead (full - count) against the number of results, whose slope is the cost per result and whose intercept is a
 * fixed cost per query. The same against the number of terms (results × variables).
 */
export function perResult(rows: Record<string, any>[]): Record<string, any> {
  const complete = rows.filter(r => VARIANTS.every(v => typeof r[v] === 'number'));
  const withRows = complete.filter(r => r.rows > 0);
  const sumRows = withRows.reduce((a, r) => a + r.rows, 0);
  const sumTerms = withRows.reduce((a, r) => a + r.terms, 0);
  const total = (key: string) => withRows.reduce((a, r) => a + r[key], 0);
  const perRow = fit(complete.map(r => ({ x: r.rows, y: r.transfer })));
  const perTerm = fit(complete.map(r => ({ x: r.terms, y: r.transfer })));
  return {
    instances: complete.length,
    instancesWithResults: withRows.length,
    rows: sumRows,
    terms: sumTerms,
    // µs per result, weighted by results: total overhead / total results.
    usPerRow: sumRows > 0 ? 1000 * (total('full') - total('count')) / sumRows : null,
    objectsUsPerRow: sumRows > 0 ? 1000 * (total('objects') - total('count')) / sumRows : null,
    readsUsPerRow: sumRows > 0 ? 1000 * (total('full') - total('objects')) / sumRows : null,
    jsonUsPerRow: sumRows > 0 ? 1000 * (total('json') - total('count')) / sumRows : null,
    medianUsPerRow: median(withRows.map(r => r.usPerRow)),
    usPerTerm: sumTerms > 0 ? 1000 * (total('full') - total('count')) / sumTerms : null,
    fitPerRow: perRow && { usPerRow: 1000 * perRow.slope, fixedMs: perRow.intercept, r2: perRow.r2, n: perRow.n },
    fitPerTerm: perTerm && { usPerTerm: 1000 * perTerm.slope, fixedMs: perTerm.intercept, r2: perTerm.r2, n: perTerm.n },
  };
}

function breakdown(dir: string, raws: Raw[], browsers: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const dataset of [ ...DATASETS, 'calibration' ]) {
    for (const browser of browsers) {
      // A complete run of a dataset takes precedence over a run of a subset of its queries.
      const candidates = raws.filter(r => r.dataset === dataset && r.browser.name === browser);
      const raw = candidates.find(r => !(r as any).querySubset) ?? candidates[0];
      if (!raw) {
        continue;
      }
      const rows = breakdownInstances(raw, dataset);
      writeCsv(join(dir, dataset, `oxigraph_breakdown_${browser}.csv`),
        [ 'query', 'rows', 'terms', ...VARIANTS.map(v => `${v}_ms`), 'objects_minus_count_ms', 'full_minus_count_ms',
          'transfer_us_per_row', 'transfer_us_per_term' ],
        rows.map(r => [ r.query, String(r.rows ?? ''), String(r.terms ?? ''),
          ...VARIANTS.map(v => typeof r[v] === 'number' ? round(r[v], 3) : r.preExcluded ? 'skipped' : String(r[v] ?? '')),
          typeof r.objects === 'number' && typeof r.count === 'number' ? round(r.objects - r.count, 3) : '',
          typeof r.transfer === 'number' ? round(r.transfer, 3) : '',
          round(r.usPerRow, 3), round(r.usPerTerm, 3) ]));
      // Totals over the instances that have all four variants (SELECT queries without failures).
      const complete = rows.filter(r => VARIANTS.every(v => typeof r[v] === 'number'));
      const sum = (v: string) => complete.reduce((a, r) => a + r[v], 0);
      const totals = Object.fromEntries(VARIANTS.map(v => [ v, sum(v) ]));
      const terms = complete.reduce((a, r) => a + (r.terms ?? 0), 0);
      const withTerms = complete.filter(r => r.terms > 0);
      out[`${dataset}/${browser}`] = {
        dataset,
        browser,
        browserVersion: raw.browser.version,
        instances: rows.length,
        complete: complete.length,
        notSelect: rows.filter(r => r.count === null && !r.preExcluded).map(r => r.query),
        preExcluded: rows.filter(r => r.preExcluded).map(r => r.query),
        failures: rows.flatMap(r => VARIANTS.filter(v => typeof r[v] === 'string').map(v => `${r.query} ${v}: ${r[v]}`)),
        totals,
        rows: complete.reduce((a, r) => a + (r.rows ?? 0), 0),
        terms,
        // Share of the full time that is not evaluation (upper bound, see the variant definitions).
        transferShare: totals.full > 0 ? (totals.full - totals.count) / totals.full : null,
        objectsShare: totals.full > 0 ? (totals.objects - totals.count) / totals.full : null,
        readShare: totals.full > 0 ? (totals.full - totals.objects) / totals.full : null,
        jsonVsFull: totals.full > 0 ? totals.json / totals.full : null,
        // Transfer cost per term, over the instances with results.
        usPerTerm: withTerms.length > 0 ?
          1000 * withTerms.reduce((a, r) => a + r.full - r.count, 0) / withTerms.reduce((a, r) => a + r.terms, 0) :
          null,
        largest: [ ...complete ].sort((a, b) => (b.full - b.count) - (a.full - a.count)).slice(0, 3)
          .map(r => ({ query: r.query, rows: r.rows, terms: r.terms, count: r.count, objects: r.objects, full: r.full, json: r.json })),
        querySubset: (raw as any).querySubset ?? null,
        perResult: perResult(rows),
        points: complete.map(r => ({ query: r.query, rows: r.rows, terms: r.terms, transfer: r.transfer })),
      };
    }
  }
  // Calibration: overhead per result for 1 and 3 variables, from scans where the COUNT wrapper cannot change the plan.
  for (const browser of browsers) {
    const calibration = out[`calibration/${browser}`];
    if (calibration) {
      const candidates = raws.filter(r => r.dataset === 'calibration' && r.browser.name === browser);
      const rows = breakdownInstances(candidates.find(r => !(r as any).querySubset) ?? candidates[0], 'calibration');
      calibration.widths = Object.fromEntries([ 1, 3 ].map(width => [ width, {
        perResult: perResult(rows.filter(r => r.query.startsWith(`w${width}-`))),
        sizes: rows.filter(r => r.query.startsWith(`w${width}-`)).map(r => ({ query: r.query, rows: r.rows,
          count: r.count, objects: r.objects, full: r.full, json: r.json, usPerRow: r.usPerRow })),
      } ]));
    }
  }

  // Estimated transfer per dataset from the calibration: the dataset's result terms times the calibrated cost per term.
  for (const b of Object.values<any>(out)) {
    const usPerTerm = out[`calibration/${b.browser}`]?.perResult?.fitPerTerm?.usPerTerm;
    if (b.dataset !== 'calibration' && usPerTerm) {
      b.calibratedUsPerTerm = usPerTerm;
      b.estimatedTransferMs = b.terms * usPerTerm / 1000;
      b.estimatedShare = b.totals.full > 0 ? b.estimatedTransferMs / b.totals.full : null;
    }
  }

  // Pooled over all benchmark datasets (not the calibration), per browser.
  for (const browser of browsers) {
    const entries = Object.values<any>(out).filter(b => b.browser === browser && !b.pooled && b.dataset !== 'calibration');
    if (entries.length === 0) {
      continue;
    }
    const rows = entries.flatMap(b => {
      const candidates = raws.filter(r => r.dataset === b.dataset && r.browser.name === browser);
      return breakdownInstances(candidates.find(r => !(r as any).querySubset) ?? candidates[0], b.dataset);
    });
    out[`all/${browser}`] = { pooled: true, dataset: 'all datasets', browser, perResult: perResult(rows) };
  }
  return out;
}

const NOTES_START = '<!-- notes:start -->';
const NOTES_END = '<!-- notes:end -->';
const fmtMs = (x: number | null | undefined) => x === null || x === undefined ? '–' :
  x >= 10_000 ? `${(x / 1000).toFixed(1)} s` : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : x >= 10 ? `${x.toFixed(0)} ms` : `${x.toFixed(1)} ms`;
const fmtKb = (bytes: number) => (bytes / 1000).toLocaleString('en', { maximumFractionDigits: 1 });
const outcomeList = (o: Record<string, number>) => Object.entries(o).filter(([ k ]) => k !== 'ok')
  .map(([ k, v ]) => `${v} ${k}`).join(', ');

/** Writes README.md: generated tables, keeping any hand-written notes between the notes markers. */
function writeReadme(dir: string, summary: Record<string, any>): void {
  const file = join(dir, 'README.md');
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const notes = previous.includes(NOTES_START) ?
    previous.slice(previous.indexOf(NOTES_START), previous.indexOf(NOTES_END) + NOTES_END.length) :
    `${NOTES_START}\n_No notes for this run._\n${NOTES_END}`;
  const meta = summary.meta ?? {};
  const m = meta.machine ?? {};
  const c = meta.comunica ?? {};
  const v = meta.versions ?? {};
  const L: string[] = [];
  L.push(`# Results: ${relative(join(ROOT, 'results'), dir)}`, '');
  L.push('Generated by `npm run aggregate` and `npm run plot` from `raw/*.json`; only the notes section is written by hand.', '');
  L.push(notes, '');
  L.push('## Setup', '');
  L.push('| | |', '|---|---|');
  L.push(`| Machine | \`${m.label}\`: ${m.cpuModel}, ${m.logicalCpus} logical CPUs, ${(m.memoryBytes / 2 ** 30).toFixed(1)} GiB RAM, ${m.osRelease ?? ''} (${m.platform}) |`);
  L.push(`| Browsers (Playwright ${v.playwright}, headless) | ${Object.entries(meta.browsers ?? {}).map(([ b, ver ]) => `${b} ${ver}`).join(', ')} |`);
  L.push(`| Comunica | \`@comunica/query-sparql-rdfjs-lite\` ${c.packageVersion} built from ${c.repository} at [\`${c.commit?.slice(0, 10)}\`](${c.repository}/commit/${c.commit}) (${c.commitDate}), N3.js ${v.n3}, rdf-stores ${v.rdfStores} (ordered store) |`);
  L.push(`| Oxigraph | \`oxigraph\` ${v.oxigraph} (\`web.js\` WASM build) |`);
  const invocations: any[] = meta.invocations ?? (meta.benchmarkRepository ? [ meta.benchmarkRepository ] : []);
  L.push(`| Benchmark code | ${invocations.map(i => `\`${String(i.commit).slice(0, 7)}\`${i.dirty ? ' (with uncommitted changes)' : ''}` +
    (invocations.length > 1 ? ` (invocation started ${i.startedAt})` : '')).join(', ') || '?'}; each raw file written by a ` +
    `resumed invocation names its commit; Vite ${v.vite} |`);
  // Repetitions as found in the raw files, per dataset (they can differ between datasets).
  const reps = Object.entries<any>(summary.datasets).map(([ d, ds ]) => [ d, Math.max(...Object.values<any>(ds.browsers)
    .flatMap((b: any) => Object.values<any>(b.engines).map((e: any) => e.repetitions))) ] as const);
  const repText = [ ...new Set(reps.map(([ , n ]) => n)) ].length === 1 ?
    `${reps[0]?.[1] ?? 1} repetitions of every timing run` :
    `repetitions of every timing run: ${reps.map(([ d, n ]) => `${d} ${n}`).join(', ')}`;
  L.push(`| Settings | ${repText}, each in a fresh browser and context; per run ${meta.settings?.warmupRounds} warmup round and ${meta.settings?.rounds} timed rounds; timeout ${meta.settings?.timeoutMs / 1000} s per execution |`);
  L.push(`| Run | ${meta.startedAt} to ${meta.updatedAt} |`, '');
  if (Object.keys(meta.skipped ?? {}).length > 0) {
    L.push('**Skipped configurations**', '');
    for (const [ k, reason ] of Object.entries(meta.skipped)) {
      L.push(`- \`${k}\`: ${reason}`);
    }
    L.push('');
  }

  if (summary.bundleSizes) {
    L.push('## Bundle size', '', 'Everything the page loads (harness, adapter, engine); gzip level 9; kB = 1000 bytes.', '');
    L.push('| Page | JS raw | JS gzip | WASM raw | WASM gzip | Total raw | Total gzip |', '|---|---:|---:|---:|---:|---:|---:|');
    for (const r of summary.bundleSizes) {
      L.push(`| ${r.page} | ${fmtKb(r.jsRaw)} | ${fmtKb(r.jsGzip)} | ${fmtKb(r.wasmRaw)} | ${fmtKb(r.wasmGzip)} | ${fmtKb(r.totalRaw)} | ${fmtKb(r.totalGzip)} |`);
    }
    L.push('', '![Bundle sizes](plot_bundle.svg)', '');
  }

  if (Object.keys(summary.support).length > 0) {
    L.push('## Support matrix', '', 'One execution of every query instance at the smallest scale of each family, ' +
      'classified against `data/<dataset>/reference.json`. Per query: [`support-matrix.csv`](support-matrix.csv).' +
      (summary.supportFromCold.length > 0 ? ` For ${summary.supportFromCold.join(', ')} (one scale only), this is the cold ` +
        'pass of the first timing repetition, which is the same procedure.' : ''), '');
    for (const [ dataset, cols ] of Object.entries<any>(summary.support)) {
      const keys = Object.keys(cols).filter(k => k !== 'nonOk');
      L.push(`**${dataset}**`, '', `| | ${keys.join(' | ')} |`, `|---|${keys.map(() => '---:').join('|')}|`);
      const total = Object.values<number>(cols[keys[0]]).reduce((a, b) => a + b, 0);
      L.push(`| ok | ${keys.map(k => `${cols[k].ok ?? 0}/${total}`).join(' | ')} |`);
      L.push(`| other | ${keys.map(k => outcomeList(cols[k]) || '–').join(' | ')} |`, '');
      const skippedColumns = keys.filter(k => Object.keys(cols[k]).length === 1 && cols[k].skipped);
      for (const column of skippedColumns) {
        L.push(`- ${column}: not run (see Skipped configurations)`);
      }
      for (const bad of cols.nonOk.filter((b: any) => !skippedColumns.includes(b.column))) {
        L.push(`- ${bad.column} ${bad.query}: ${bad.outcome}${bad.error ? ` (${String(bad.error).slice(0, 160)})` : ''}`);
      }
      if (cols.nonOk.length > 0) {
        L.push('');
      }
    }
  }

  L.push('## Query times, load and memory', '');
  L.push('Timing runs were repeated (see Setup); warm statistics pool the timed rounds of all repetitions (per instance: repetitions × 5 ' +
    'executions), cold is the mean of the cold executions over repetitions, and per-run values (init, load, memory) are medians ' +
    'over repetitions, with the range in parentheses. Totals add the per-instance warm means. "All ok" sums each engine over its ' +
    'own ok instances; "common" sums over the instances that both engines got ok in that browser, which is the ' +
    'comparable number. Engine init = loading the adapter chunk (JS, plus WASM for Oxigraph) + constructing the engine. ' +
    'Load = parse + ingest; Oxigraph parses and ingests inside one `Store.load()` call, so its parse column is empty. ' +
    'Memory: Chromium only.', '');
  for (const [ dataset, ds ] of Object.entries<any>(summary.datasets)) {
    L.push(`### ${dataset}`, '');
    L.push('| Browser | Engine | ok | Total warm (all ok) | Total warm (common) | Total cold (common) | Geomean warm (common) | Init | Fetch+inflate | Parse | Ingest | Load | Memory |');
    L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const [ browser, b ] of Object.entries<any>(ds.browsers)) {
      for (const [ engine, e ] of Object.entries<any>(b.engines)) {
        const total = Object.values<number>(e.outcomes).reduce((x, y) => x + y, 0);
        const other = outcomeList(e.outcomes);
        L.push(`| ${browser} | ${engine} | ${e.outcomes.ok ?? 0}/${total}${other ? ` (${other})` : ''} | ${fmtMs(e.totalWarmMs)} | ` +
          `${fmtMs(e.commonWarmMs)} (${b.commonOk}) | ${fmtMs(e.commonColdMs)} | ${fmtMs(e.commonGeomeanWarmMs)} | ${fmtMs(e.initMs)} | ` +
          `${fmtMs(e.fetchInflateMs)} | ${e.parseMs === null ? '–' : fmtMs(e.parseMs)} | ${fmtMs(e.ingestMs)} | ` +
          `${fmtMs(e.load.median)} (${fmtMs(e.load.min)}–${fmtMs(e.load.max)}) | ` +
          `${e.memoryMB === null ? '–' : `${e.memoryMB.toFixed(1)} MB`} |`);
      }
    }
    L.push('', '<details><summary>Three slowest instances per engine (warm mean [fastest–slowest execution]; cold mean)</summary>', '');
    for (const [ browser, b ] of Object.entries<any>(ds.browsers)) {
      for (const [ engine, e ] of Object.entries<any>(b.engines)) {
        L.push(`- ${browser} / ${engine}: ${e.slowest.map((q: any) => `${q.query} ${fmtMs(q.warmMeanMs)} [${fmtMs(q.warmMinMs)}–${fmtMs(q.warmMaxMs)}]; cold ${fmtMs(q.coldMs)}`).join(', ')}`);
      }
    }
    L.push('', '</details>', '');
    const failures = Object.entries<any>(ds.browsers).flatMap(([ browser, b ]) => Object.entries<any>(b.engines)
      .flatMap(([ engine, e ]) => e.status === 'skipped' ?
        [ `- ${browser} / ${engine}: not run (see Skipped configurations)` ] :
        e.failures.map((f: any) => `- ${browser} / ${engine} ${f.query}: ${f.outcome}${f.error ? ` (${String(f.error).slice(0, 160)})` : ''}`)));
    if (failures.length > 0) {
      L.push('Not ok:', '', ...failures, '');
    }
    for (const browser of Object.keys(ds.browsers)) {
      L.push(`![${dataset} ${browser}](${dataset}/plot_${browser}.svg)`, '');
    }
    L.push(`Per instance: ${Object.keys(ds.browsers).map(b => `[\`${dataset}/instances_${b}.csv\`](${dataset}/instances_${b}.csv)`).join(', ')}; ` +
      `per template: \`${dataset}/plot_<browser>.csv\`; totals: [\`${dataset}/totals.csv\`](${dataset}/totals.csv); load: [\`${dataset}/plot_load.csv\`](${dataset}/plot_load.csv).`, '');
  }
  const breakdowns = Object.values<any>(summary.breakdown ?? {}).filter(b => !b.pooled);
  if (breakdowns.length > 0) {
    L.push('## Oxigraph: evaluation against moving results into JavaScript', '');
    L.push('Breakdown mode (`--mode breakdown`), Oxigraph only: every query instance runs as four variants on the same page, ' +
      'in an order that rotates per round (1 warmup round, then the mean of the timed rounds). ' +
      '**count**: `SELECT (COUNT(*) AS ?n) WHERE { { query } }`, so Oxigraph evaluates the query but only one number ' +
      'crosses into JavaScript (a lower bound on evaluation: the wrapper may let Oxigraph skip work such as an ORDER BY ' +
      'without LIMIT). **objects**: `store.query(q)`, which also builds the JS result (a `Map` and a wrapper object per term). ' +
      '**full**: also reads every term\'s value, which copies it out of WASM memory; this is what the timing runs measure. ' +
      '**json**: the result serialized as SPARQL JSON inside WASM and handed over as one string, then `JSON.parse` and ' +
      'every value read. Totals are over the SELECT instances that have all four variants; "transfer" = (full − count) ÷ full, ' +
      'an upper bound on the share of the time spent moving results into JavaScript.', '');
    L.push('Measured and estimated: the "measured" columns subtract the variants per query, which cannot resolve a ' +
      'difference smaller than the query\'s own run-to-run variation (see the per-result section); "estimated" is the ' +
      'dataset\'s number of result terms times the cost per term measured on the calibration scans in the same browser.', '');
    L.push('| Dataset | Browser | Instances | Rows | Terms | count | objects | full | json | Measured transfer share | of which objects | of which reads | Measured per term | Estimated transfer (calibration) | Estimated share | json ÷ full |');
    L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const pct = (x: number | null) => x === null ? '–' : `${(100 * x).toFixed(1)} %`;
    for (const b of breakdowns) {
      L.push(`| ${b.dataset}${b.querySubset ? ` (${b.querySubset.length} queries)` : ''} | ${b.browser} | ${b.complete}/${b.instances} | ${b.rows.toLocaleString('en')} | ${b.terms.toLocaleString('en')} | ` +
        `${fmtMs(b.totals.count)} | ${fmtMs(b.totals.objects)} | ${fmtMs(b.totals.full)} | ${fmtMs(b.totals.json)} | ` +
        `${pct(b.transferShare)} | ${pct(b.objectsShare)} | ${pct(b.readShare)} | ` +
        `${b.usPerTerm === null ? '–' : `${b.usPerTerm.toFixed(2)} µs`} | ` +
        `${b.estimatedTransferMs === undefined ? '–' : fmtMs(b.estimatedTransferMs)} | ${b.estimatedShare === undefined ? '–' : pct(b.estimatedShare)} | ` +
        `${b.jsonVsFull === null ? '–' : b.jsonVsFull.toFixed(2)} |`);
    }
    L.push('', '### Overhead per result', '');
    L.push('The overhead of a query is full − count. Per dataset and browser, over the instances with all four variants: ' +
      '"weighted" = total overhead ÷ total results; "median" = median over the instances with results of their overhead ÷ ' +
      'results; "fit" = least-squares line of overhead against results, whose slope is the cost per result and whose ' +
      'intercept is a fixed cost per query (R² says how well results explain the overhead). Split: building the JS ' +
      'objects (objects − count) and reading the values (full − objects), weighted. Sub-millisecond differences are at ' +
      'the resolution of `performance.now()` (5 µs, with jitter, in a cross-origin isolated page), so per-instance values ' +
      'of small queries are noisy; the weighted and fitted values are dominated by the queries with many results.', '');
    L.push('| Dataset | Browser | Instances (with results) | Results | Weighted µs/result | of which objects | of which reads | Median µs/result | Fit µs/result | Fit fixed ms/query | R² | µs/term (weighted) | json − count µs/result |');
    L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const n2 = (x: number | null | undefined, d = 2) => x === null || x === undefined ? '–' : x.toFixed(d);
    for (const b of Object.values<any>(summary.breakdown)) {
      const p = b.perResult;
      L.push(`| ${b.dataset}${b.querySubset ? ` (${b.querySubset.length} queries)` : ''} | ${b.browser} | ${p.instances} (${p.instancesWithResults}) | ` +
        `${p.rows.toLocaleString('en')} | ${n2(p.usPerRow)} | ${n2(p.objectsUsPerRow)} | ${n2(p.readsUsPerRow)} | ${n2(p.medianUsPerRow)} | ` +
        `${n2(p.fitPerRow?.usPerRow)} | ${n2(p.fitPerRow?.fixedMs, 3)} | ${n2(p.fitPerRow?.r2)} | ${n2(p.usPerTerm)} | ${n2(p.jsonUsPerRow)} |`);
    }
    L.push('', '![Overhead against results](plot_oxigraph_overhead.svg)', '');
    const calibrations = breakdowns.filter(b => b.widths);
    if (calibrations.length > 0) {
      L.push('### Calibration: overhead per result without query evaluation', '');
      L.push('`SELECT ?s WHERE { ?s ?p ?o } LIMIT N` (1 variable) and `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT N` ' +
        '(3 variables) over the watdiv-10 data ([`data/calibration`](../../data/calibration)). Evaluating them is a scan of ' +
        'N triples whether or not the COUNT wrapper is around them, so here full − count is the cost of producing N ' +
        'results as JS objects and reading them, and json − count that of the serialized path.', '');
      L.push('| Browser | Variables | N | count | objects | full | json | (full − count) ÷ N | (json − count) ÷ N |');
      L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
      const us = (x: number | null | undefined) => x === null || x === undefined ? '–' : `${x.toFixed(2)} µs`;
      for (const b of calibrations) {
        for (const [ width, w ] of Object.entries<any>(b.widths)) {
          for (const r of w.sizes) {
            L.push(`| ${b.browser} | ${width} | ${r.rows?.toLocaleString('en') ?? '–'} | ${fmtMs(r.count)} | ${fmtMs(r.objects)} | ` +
              `${fmtMs(r.full)} | ${fmtMs(r.json)} | ${us(r.usPerRow)} | ` +
              `${typeof r.json === 'number' && r.rows > 0 ? us(1000 * (r.json - r.count) / r.rows) : '–'} |`);
          }
          const f = w.perResult.fitPerRow;
          L.push(`| ${b.browser} | ${width} | fit | | | | | ${f ? `${f.usPerRow.toFixed(2)} µs + ${f.fixedMs.toFixed(3)} ms (R² ${f.r2.toFixed(3)})` : '–'} | |`);
        }
      }
      L.push('');
    }
    L.push('', '<details><summary>Largest absolute transfer cost (full − count) per dataset and browser</summary>', '');
    for (const b of breakdowns) {
      L.push(`- ${b.dataset} / ${b.browser}: ${b.largest.map((r: any) => `${r.query} (${r.rows} rows, ${r.terms} terms): ` +
        `count ${fmtMs(r.count)}, objects ${fmtMs(r.objects)}, full ${fmtMs(r.full)}, json ${fmtMs(r.json)}`).join('; ')}`);
    }
    L.push('', '</details>', '');
    const excludedNotes = breakdowns.filter(b => b.preExcluded.length > 0 || b.failures.length > 0 || b.notSelect.length > 0);
    for (const b of excludedNotes) {
      L.push(`- ${b.dataset} / ${b.browser}: ` + [
        b.notSelect.length > 0 ? `no count variant (not SELECT): ${b.notSelect.join(', ')}` : '',
        b.preExcluded.length > 0 ? `not run (timed out in the timing runs): ${b.preExcluded.join(', ')}` : '',
        b.failures.length > 0 ? `failed: ${b.failures.join('; ')}` : '',
      ].filter(Boolean).join('; '));
    }
    L.push('', '![Oxigraph breakdown](plot_oxigraph_breakdown.svg)', '');
    L.push('Per instance: `<dataset>/oxigraph_breakdown_<browser>.csv`.', '');
    L.push('### Evaluation against transfer, as stacked bars', '');
    L.push('Oxigraph\'s full time split into evaluation and WASM → JS transfer, with the transfer estimated from the ' +
      'calibration (result terms × cost per term in that browser), by `npm run plot:split`. Per template: ' +
      '`<dataset>/plot_oxigraph_split_<browser>.svg` and `<dataset>/oxigraph_split_<browser>.csv`.', '');
    L.push('![Oxigraph: evaluation against transfer](plot_oxigraph_split.svg)', '');
    for (const browser of (summary.browsers as string[]).filter(b => existsSync(join(dir, `plot_oxigraph_split_top_${b}.svg`)))) {
      L.push(`The templates with the most transfer, next to Comunica (${browser}; numbers in ` +
        `[\`oxigraph_split_top_${browser}.csv\`](oxigraph_split_top_${browser}.csv)):`, '');
      L.push(`![Templates with the most transfer, ${browser}](plot_oxigraph_split_top_${browser}.svg)`, '');
    }
  }
  if (Object.keys(summary.datasets).length > 0) {
    L.push('## Load and memory overview', '', '![Load time](plot_load.svg)', '', '![Memory after load](plot_memory.svg)', '');
  }
  writeFileSync(file, `${L.join('\n')}\n`);
}

export function countOutcomes(stats: InstanceStats[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of stats) {
    counts[s.outcome] = (counts[s.outcome] ?? 0) + 1;
  }
  return counts;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
