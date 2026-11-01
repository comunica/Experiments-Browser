// Aggregates results/<dir>/raw/*.json into CSVs (Experiments-Centralized column shape), totals, the support
// matrix, summary.json and the generated parts of results/<dir>/README.md.
// Usage: npm run aggregate [-- results/<dir>]   (defaults to the most recently modified results directory)
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
export const ENGINES = [ 'comunica', 'oxigraph' ];
export const BROWSERS = [ 'chromium', 'firefox', 'webkit' ];
export const DATASETS = [ 'watdiv-1', 'watdiv-10', 'bsbm-100', 'bsbm-1k', 'ldbc-snb-0.1' ];
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
const round = (x: number | null | undefined, digits = 2) =>
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

function writeCsv(file: string, header: string[], rows: (string | number)[][]): void {
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

  summary.meta = meta;
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  writeReadme(dir, summary);
  console.log(`Aggregated ${raws.length} raw files into ${relative(ROOT, dir)}`);
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
      for (const bad of cols.nonOk) {
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
      .flatMap(([ engine, e ]) => e.failures.map((f: any) => `- ${browser} / ${engine} ${f.query}: ${f.outcome}${f.error ? ` (${String(f.error).slice(0, 160)})` : ''}`)));
    if (failures.length > 0) {
      L.push('Not ok:', '', ...failures, '');
    }
    for (const browser of Object.keys(ds.browsers)) {
      L.push(`![${dataset} ${browser}](${dataset}/plot_${browser}.svg)`, '');
    }
    L.push(`Per instance: ${Object.keys(ds.browsers).map(b => `[\`${dataset}/instances_${b}.csv\`](${dataset}/instances_${b}.csv)`).join(', ')}; ` +
      `per template: \`${dataset}/plot_<browser>.csv\`; totals: [\`${dataset}/totals.csv\`](${dataset}/totals.csv); load: [\`${dataset}/plot_load.csv\`](${dataset}/plot_load.csv).`, '');
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
