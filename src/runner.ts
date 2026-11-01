// Playwright runner: serves dist/ and data/ with COOP+COEP, opens one fresh browser and context per
// (browser, engine, dataset) run, relays the in-page events, and writes results/<dir>/raw/*.json.
// It never measures time itself: the watchdog only kills a page that stopped responding.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import type { Browser, BrowserType, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';
import type { BenchConfig, BenchEvent, ExecResult, LoadInfo, MemoryInfo, Step } from './protocol';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const DATA = join(ROOT, 'data');

export const ENGINES = {
  comunica: { page: 'comunica.html' },
  oxigraph: { page: 'oxigraph.html' },
} as const;
export type EngineName = keyof typeof ENGINES;
const BROWSERS: Record<string, BrowserType> = { chromium, firefox, webkit };
// New headless mode (the full browser, not headless-shell): only there is the renderer locked to a site,
// which measureUserAgentSpecificMemory() requires. gc() is exposed so garbage from loading is dropped
// before measuring; ForceEagerMeasureMemory measures right away instead of waiting up to 20 s for a GC.
export const CHROMIUM_LAUNCH = {
  channel: 'chromium',
  args: [ '--js-flags=--expose-gc', '--enable-blink-features=ForceEagerMeasureMemory', '--enable-precise-memory-info' ],
};
// LDBC SNB has one scale: its support pass would repeat the cold pass of the first timing repetition, which
// scripts/aggregate.ts uses instead.
export const SUPPORT_DATASETS = [ 'watdiv-1', 'bsbm-100' ];
export const DATASETS = [ 'watdiv-1', 'watdiv-10', 'bsbm-100', 'bsbm-1k', 'ldbc-snb-0.1' ];

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'all' },
    browsers: { type: 'string', default: 'chromium,firefox,webkit' },
    engines: { type: 'string', default: Object.keys(ENGINES).join(',') },
    datasets: { type: 'string' },
    out: { type: 'string' },
    machine: { type: 'string', default: process.env.BENCH_MACHINE ?? os.hostname() },
    rounds: { type: 'string', default: '5' },
    warmup: { type: 'string', default: '1' },
    repeat: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '60000' },
    grace: { type: 'string', default: '30000' },
    'load-timeout': { type: 'string', default: '900000' },
    skip: { type: 'string', default: '' },
    force: { type: 'boolean', default: false },
  },
});

const TIMEOUT_MS = Number(args.timeout);
const GRACE_MS = Number(args.grace);
const LOAD_TIMEOUT_MS = Number(args['load-timeout']);
const ROUNDS = Number(args.rounds);
const WARMUP = Number(args.warmup);
const REPEAT = Number(args.repeat);
const OUT = resolve(ROOT, args.out ?? join('results', `${new Date().toISOString().slice(0, 10)}-${args.machine}`));
// Configurations that are deliberately not run, as browser/engine/dataset=reason;...
const SKIPS = new Map(args.skip.split(';').filter(Boolean).map((entry) => {
  const [ key, ...reason ] = entry.split('=');
  return [ key, reason.join('=') ];
}));

// --- Static server -------------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.sparql': 'application/sparql-query; charset=utf-8',
  // Served as an opaque file (no Content-Encoding): the page inflates it itself, and that is timed.
  '.gz': 'application/gzip',
};

function startServer(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const [ base, rel ] = path.startsWith('/data/') ? [ DATA, path.slice('/data/'.length) ] : [ DIST, path.slice(1) ];
    const file = normalize(join(base, rel));
    if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      'cache-control': 'no-store',
      // Cross-origin isolation, required by performance.measureUserAgentSpecificMemory().
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => server.close(),
    }));
  });
}

// --- One page attempt ----------------------------------------------------------------------------

interface Attempt {
  status: 'done' | 'crashed' | 'watchdog' | 'fatal' | 'load-timeout' | 'restart';
  build?: unknown;
  userAgent?: string;
  crossOriginIsolated?: boolean;
  load?: LoadInfo;
  memory?: MemoryInfo;
  executions: ExecResult[];
  inFlight?: Step;
  error?: string;
  steps: number;
}

async function runAttempt(
  browserName: string,
  browser: Browser,
  serverUrl: string,
  config: BenchConfig,
): Promise<Attempt> {
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  const attempt: Attempt = { status: 'fatal', executions: [], steps: config.steps.length };
  let finish: (status: Attempt['status']) => void = () => {};
  const finished = new Promise<void>((resolveDone) => {
    finish = (status) => {
      attempt.status = status;
      resolveDone();
    };
  });
  let watchdog: NodeJS.Timeout | undefined;
  const arm = (ms: number, status: Attempt['status']) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => finish(status), ms);
  };

  await page.addInitScript((cfg) => {
    (window as unknown as { __BENCH_CONFIG__: unknown }).__BENCH_CONFIG__ = cfg;
  }, config);
  await page.exposeBinding('__benchEvent', async(_source, event: BenchEvent) => {
    switch (event.type) {
      case 'build':
        Object.assign(attempt, { build: event.build, userAgent: event.userAgent, crossOriginIsolated: event.crossOriginIsolated });
        break;
      case 'loaded':
        attempt.load = event.load;
        clearTimeout(watchdog);
        break;
      case 'memory':
        attempt.memory = event.memory;
        if (browserName === 'chromium') {
          // Fallback and cross-check: V8 heap usage over CDP, plus the WASM memory the page reported.
          const cdp = await context.newCDPSession(page);
          const heap = await cdp.send('Runtime.getHeapUsage') as { usedSize: number; totalSize: number };
          await cdp.detach();
          Object.assign(attempt.memory, { cdpHeapUsedBytes: heap.usedSize, cdpHeapTotalBytes: heap.totalSize });
          if (event.memory.bytes === null) {
            Object.assign(attempt.memory, { method: 'cdp+wasm', bytes: heap.usedSize + (event.memory.wasmBytes ?? 0) });
          }
        }
        break;
      case 'start':
        attempt.inFlight = event.step;
        arm(config.timeoutMs + GRACE_MS, 'watchdog');
        if (browserName === 'chromium' && process.env.BENCH_TEST_CRASH_QUERY === event.step.query) {
          // Test hook for the crash path only.
          const cdp = await context.newCDPSession(page);
          cdp.send('Page.crash').catch(() => {});
        }
        break;
      case 'exec':
        attempt.executions.push(event.result);
        attempt.inFlight = undefined;
        clearTimeout(watchdog);
        if (attempt.executions.length % 25 === 0 || event.result.outcome !== 'ok') {
          const r = event.result;
          console.log(`    ${r.phase}#${r.round} ${r.query}: ${r.outcome} ${r.ms === null ? '' : `${r.ms.toFixed(1)} ms`} ${r.count ?? ''}${r.error ? ` (${r.error.slice(0, 120)})` : ''}`);
        }
        break;
      case 'done':
        finish('done');
        break;
      case 'restart':
        attempt.error = event.reason;
        finish('restart');
        break;
      case 'fatal':
        attempt.error = event.error;
        finish('fatal');
        break;
    }
  });
  page.on('crash', () => finish('crashed'));
  page.on('pageerror', error => console.log(`    [pageerror] ${String(error).slice(0, 300)}`));
  arm(LOAD_TIMEOUT_MS, 'load-timeout');
  page.goto(`${serverUrl}/${ENGINES[config.engine as EngineName].page}`).catch((error: unknown) => {
    attempt.error = String(error);
    finish('fatal');
  });
  await finished;
  clearTimeout(watchdog);
  await context.close().catch(() => {});
  return attempt;
}

// --- One (browser, engine, dataset) run, surviving crashes and hung pages ------------------------

function queryIds(dataset: string): string[] {
  return readdirSync(join(DATA, dataset, 'queries'))
    .filter(file => file.endsWith('.sparql'))
    .map(file => file.replace(/\.sparql$/u, ''))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function plan(mode: string, queries: string[]): Step[] {
  if (mode === 'support') {
    return queries.map(query => ({ phase: 'support', round: 0, query }));
  }
  const steps: Step[] = queries.map(query => ({ phase: 'cold', round: 0, query }));
  for (let round = 1; round <= WARMUP; round++) {
    steps.push(...queries.map(query => <Step>{ phase: 'warmup', round, query }));
  }
  for (let round = 1; round <= ROUNDS; round++) {
    steps.push(...queries.map(query => <Step>{ phase: 'timed', round, query }));
  }
  return steps;
}

const sameStep = (a: Step, b: Step) => a.phase === b.phase && a.round === b.round && a.query === b.query;

async function runConfiguration(
  serverUrl: string,
  mode: string,
  browserName: string,
  engine: EngineName,
  dataset: string,
): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const all = plan(mode, queryIds(dataset));
  const excluded = new Map<string, string>();
  const executions: ExecResult[] = [];
  const attempts: Record<string, unknown>[] = [];
  let remaining = all;
  let browserVersion = '';
  let status = 'complete';
  let stalls = 0;

  while (remaining.length > 0) {
    // After a restart in the warm phases, one unrecorded round re-warms the fresh page first.
    let steps = remaining.filter(step => !excluded.has(step.query));
    if (attempts.length > 0 && steps.length > 0 && (steps[0].phase === 'warmup' || steps[0].phase === 'timed')) {
      const rewarm = [ ...new Set(steps.map(step => step.query)) ].map(query => <Step>{ phase: 'rewarm', round: 0, query });
      steps = [ ...rewarm, ...steps ];
    }
    if (steps.length === 0) {
      break;
    }
    const browser = await BROWSERS[browserName].launch(browserName === 'chromium' ? CHROMIUM_LAUNCH : {});
    browserVersion = browser.version();
    const config: BenchConfig = {
      dataset,
      engine,
      measureMemory: attempts.length === 0 && browserName === 'chromium',
      timeoutMs: TIMEOUT_MS,
      steps,
    };
    const attempt = await runAttempt(browserName, browser, serverUrl, config);
    await browser.close().catch(() => {});
    const done = new Set<number>();
    for (const result of attempt.executions) {
      executions.push(result);
      if (result.outcome === 'timeout' || result.outcome === 'error' || result.outcome === 'unsupported') {
        excluded.set(result.query, result.outcome);
      }
      const index = remaining.findIndex(step => sameStep(step, result));
      if (index >= 0) {
        done.add(index);
      }
    }
    attempts.push({
      status: attempt.status,
      error: attempt.error,
      build: attempt.build,
      userAgent: attempt.userAgent,
      crossOriginIsolated: attempt.crossOriginIsolated,
      load: attempt.load,
      memory: attempt.memory,
      steps: steps.length,
      executions: attempt.executions.length,
      inFlight: attempt.inFlight,
    });
    console.log(`  attempt ${attempts.length}: ${attempt.status}, ${attempt.executions.length}/${steps.length} executions` +
      (attempt.load ? `, load ${attempt.load.loadMs.toFixed(0)} ms` : '') + (attempt.error ? `, ${attempt.error.slice(0, 300)}` : ''));

    if (attempt.status === 'done') {
      remaining = [];
      break;
    }
    if (!attempt.load || attempt.status === 'fatal') {
      // Nothing can be run if the dataset does not load; the page error is published as is.
      status = attempt.status === 'crashed' ? 'oom' : attempt.status === 'fatal' ? 'error' : 'load-timeout';
      break;
    }
    if (attempt.inFlight && attempt.inFlight.phase !== 'rewarm') {
      const outcome = attempt.status === 'crashed' ? 'oom' : 'timeout';
      executions.push({
        ...attempt.inFlight,
        outcome,
        ms: null,
        count: null,
        expected: null,
        checksum: null,
        error: attempt.status === 'crashed' ? 'page crashed' : `no response within ${TIMEOUT_MS + GRACE_MS} ms; page killed`,
      });
      excluded.set(attempt.inFlight.query, outcome);
      done.add(remaining.findIndex(step => sameStep(step, attempt.inFlight!)));
    } else if (attempt.inFlight) {
      // Crashed or hung while re-warming: that query is excluded as well.
      excluded.set(attempt.inFlight.query, attempt.status === 'crashed' ? 'oom' : 'timeout');
      executions.push({ ...attempt.inFlight, outcome: attempt.status === 'crashed' ? 'oom' : 'timeout', ms: null,
        count: null, expected: null, checksum: null, error: 'failed during re-warm round' });
    }
    if (done.size === 0 && !attempt.inFlight) {
      // A page that dies between executions twice in a row will not get further.
      if (++stalls >= 2) {
        status = `stalled (${attempt.status})`;
        break;
      }
    } else {
      stalls = 0;
    }
    remaining = remaining.filter((_, index) => !done.has(index));
  }

  return {
    schema: 1,
    mode,
    dataset,
    browser: { name: browserName, version: browserVersion },
    engine: { name: engine, ...ENGINES[engine] },
    build: attempts.find(a => a.build)?.build,
    userAgent: attempts.find(a => a.userAgent)?.userAgent,
    machine: args.machine,
    startedAt,
    finishedAt: new Date().toISOString(),
    settings: { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, warmupRounds: WARMUP, rounds: ROUNDS },
    status,
    load: (attempts[0] as { load?: LoadInfo })?.load ?? null,
    memory: (attempts[0] as { memory?: MemoryInfo })?.memory ?? null,
    attempts,
    executions,
  };
}

// --- Metadata ------------------------------------------------------------------------------------

function machineInfo(): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    label: args.machine,
    cpuModel: cpus[0]?.model,
    logicalCpus: cpus.length,
    memoryBytes: os.totalmem(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    osRelease: existsSync('/etc/os-release') ?
      /PRETTY_NAME="?([^"\n]+)/u.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] :
      undefined,
    node: process.version,
  };
}

function gitInfo(): Record<string, unknown> {
  try {
    const run = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] }).trim();
    return { commit: run('rev-parse', 'HEAD'), dirty: run('status', '--porcelain').length > 0 };
  } catch {
    return {};
  }
}

const version = (name: string) => JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;

// --- Main ----------------------------------------------------------------------------------------

/** Refuses to run a dist/ that is older than the page sources it was built from. */
function assertFreshBuild(): void {
  const manifest = join(DIST, '.vite', 'manifest.json');
  if (!existsSync(manifest)) {
    throw new Error('dist/ is missing; run `npm run build` first.');
  }
  const built = statSync(manifest).mtimeMs;
  const sources = [ 'src/harness.ts', 'src/protocol.ts', 'src/adapters', 'src/pages', 'vite.config.ts' ]
    .flatMap(path => statSync(join(ROOT, path)).isDirectory() ?
      readdirSync(join(ROOT, path)).map(file => join(ROOT, path, file)) :
      [ join(ROOT, path) ]);
  const stale = sources.filter(file => statSync(file).mtimeMs > built);
  if (stale.length > 0) {
    throw new Error(`dist/ is older than ${stale.join(', ')}; run \`npm run build\` first.`);
  }
}

async function main(): Promise<void> {
  assertFreshBuild();
  mkdirSync(join(OUT, 'raw'), { recursive: true });
  const metaFile = join(OUT, 'meta.json');
  const meta: Record<string, any> = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  meta.machine = machineInfo();
  meta.benchmarkRepository = gitInfo();
  meta.comunica = JSON.parse(readFileSync(join(ROOT, '.cache', 'comunica-build.json'), 'utf8'));
  meta.versions = {
    oxigraph: version('oxigraph'),
    n3: version('n3'),
    rdfStores: version('rdf-stores'),
    playwright: version('playwright'),
    vite: version('vite'),
  };
  meta.settings = { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, warmupRounds: WARMUP, rounds: ROUNDS, repetitions: REPEAT,
    chromiumLaunch: CHROMIUM_LAUNCH, headless: true };
  meta.browsers ??= {};
  meta.skipped ??= {};
  meta.runs ??= [];
  meta.startedAt ??= new Date().toISOString();
  if (existsSync(join(DIST, 'bundle-sizes.json'))) {
    writeFileSync(join(OUT, 'bundle-sizes.json'), readFileSync(join(DIST, 'bundle-sizes.json')));
  }

  const browsers = args.browsers.split(',').filter(Boolean);
  const engines = args.engines.split(',').filter(Boolean) as EngineName[];
  const modes = args.mode === 'all' ? [ 'support', 'timing' ] : [ args.mode ];
  const server = await startServer();
  try {
    for (const mode of modes) {
      const datasets = args.datasets?.split(',') ?? (mode === 'support' ? SUPPORT_DATASETS : DATASETS);
      // Repetitions are the outer loop, so a transient slowdown of the machine hits one repetition of many
      // configurations instead of every repetition of one. The support pass only classifies, once.
      const repetitions = mode === 'support' ? 1 : REPEAT;
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        for (const dataset of datasets) {
          for (const browserName of browsers) {
            for (const engine of engines) {
              const key = `${browserName}/${engine}/${dataset}`;
              const name = `${mode}-${dataset}-${browserName}-${engine}${mode === 'support' ? '' : `-r${repetition}`}.json`;
              const file = join(OUT, 'raw', name);
              if (SKIPS.has(key) || SKIPS.has(`${key}/${mode}`)) {
                meta.skipped[`${mode}/${key}`] = SKIPS.get(key) ?? SKIPS.get(`${key}/${mode}`);
                console.log(`skip ${mode} ${key}: ${meta.skipped[`${mode}/${key}`]}`);
                continue;
              }
              if (!args.force && existsSync(file)) {
                console.log(`exists ${name}`);
                continue;
              }
              console.log(`run ${name}`);
              const result = await runConfiguration(server.url, mode, browserName, engine, dataset);
              result.repetition = mode === 'support' ? 1 : repetition;
              meta.browsers[browserName] = (result.browser as { version: string }).version;
              meta.runs.push({ file: `raw/${name}`, status: result.status, startedAt: result.startedAt, finishedAt: result.finishedAt });
              writeFileSync(file, `${JSON.stringify(result, null, 1)}\n`);
              meta.updatedAt = new Date().toISOString();
              writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
            }
          }
        }
      }
    }
  } finally {
    server.close();
  }
  meta.updatedAt = new Date().toISOString();
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Results in ${OUT}`);
}

await main();
