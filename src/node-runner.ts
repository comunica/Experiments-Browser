// Runs the browser benchmark's steps for Comunica in Node, to compare with the browsers on the same V8 family: same
// Comunica build (the monorepo checkout), same store, loader and query function as the page, same steps and outcome
// classes. Every dataset and repetition runs in a fresh Node process; raw files use the runner's format, with the
// Node major version as browser name ("node22", "node24"), so several Node versions can share a results directory.
// Run it with another Node version by putting it first on the PATH.
// Usage: npm run bench:node -- [--mode warmup|timing] [--datasets watdiv-1,...] [--repeat 3] [--curve-rounds 30]
//   [--warmup 1] [--rounds 5] [--timeout 60000] [--out results/<dir>] [--machine label]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { loadOrderedStore, runComunicaQuery } from './adapters/comunica';
import { QueryTimeoutError } from './adapters/types';
import { readChunks } from './node-chunks';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'data');

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'warmup' },
    datasets: { type: 'string', default: 'watdiv-1,watdiv-10,bsbm-100,bsbm-1k,bsbm-10k' },
    repeat: { type: 'string', default: '3' },
    'curve-rounds': { type: 'string', default: '30' },
    warmup: { type: 'string', default: '10' },
    rounds: { type: 'string', default: '5' },
    timeout: { type: 'string', default: '60000' },
    out: { type: 'string' },
    machine: { type: 'string', default: process.env.BENCH_MACHINE ?? os.hostname() },
    force: { type: 'boolean', default: false },
    // Internal: run one configuration in this process.
    child: { type: 'string' },
  },
});
if (args.mode !== 'warmup' && args.mode !== 'timing') {
  throw new Error(`--mode must be warmup or timing, not ${args.mode}`);
}
const OUT = resolve(ROOT, args.out ?? join('results', `${new Date().toISOString().slice(0, 10)}-${args.machine}`));
const version = (name: string) => JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
const ENV = `node${process.versions.node.split('.')[0]}`;
const rawName = (dataset: string, repetition: number) => `${args.mode}-${dataset}-${ENV}-comunica-r${repetition}.json`;

interface Step {
  phase: 'cold' | 'warmup' | 'timed';
  round: number;
  query: string;
}

function plan(queries: string[]): Step[] {
  const steps: Step[] = queries.map(query => ({ phase: 'cold', round: 0, query }));
  const rounds: [Step['phase'], number][] = args.mode === 'warmup' ?
    Array.from({ length: Number(args['curve-rounds']) }, (_, i) => [ 'timed', i + 1 ]) :
    [ ...Array.from({ length: Number(args.warmup) }, (_, i) => <[Step['phase'], number]>[ 'warmup', i + 1 ]),
      ...Array.from({ length: Number(args.rounds) }, (_, i) => <[Step['phase'], number]>[ 'timed', i + 1 ]) ];
  for (const [ phase, round ] of rounds) {
    steps.push(...queries.map(query => ({ phase, round, query })));
  }
  return steps;
}

/** One configuration, in this (fresh) process. */
async function child(dataset: string, repetition: number): Promise<void> {
  const startedAt = new Date().toISOString();
  const dir = join(DATA, dataset, 'queries');
  const queries = readdirSync(dir).filter(f => f.endsWith('.sparql')).map(f => f.replace(/\.sparql$/u, ''))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const texts = new Map(queries.map(q => [ q, readFileSync(join(dir, `${q}.sparql`), 'utf8') ]));
  const reference = JSON.parse(readFileSync(join(DATA, dataset, 'reference.json'), 'utf8')).queries;
  const t0 = performance.now();
  const chunks = readChunks(join(DATA, dataset, 'dataset.nt.gz'));
  const inflateMs = performance.now() - t0;
  const { store, result: load } = loadOrderedStore(chunks);
  (globalThis as { gc?: () => void }).gc?.();
  const engine = new QueryEngine();
  const timeoutMs = Number(args.timeout);
  const executions: Record<string, unknown>[] = [];
  for (const step of plan(queries)) {
    const expected: number | null = reference[step.query]?.count ?? null;
    const start = performance.now();
    try {
      const result = await runComunicaQuery(engine, store, texts.get(step.query)!, timeoutMs);
      const ms = performance.now() - start;
      executions.push({ ...step, outcome: expected === null ? 'unchecked' : result.count === expected ? 'ok' : 'wrong',
        ms, count: result.count, expected, checksum: result.checksum, resultType: result.resultType });
    } catch (error: unknown) {
      executions.push({ ...step, outcome: error instanceof QueryTimeoutError ? 'timeout' : 'error', ms: null, count: null,
        expected, error: String((error as Error).message ?? error).slice(0, 500) });
    }
  }
  const comunica = JSON.parse(readFileSync(join(ROOT, '.cache', 'comunica-build.json'), 'utf8'));
  const raw = {
    schema: 1,
    mode: args.mode,
    dataset,
    browser: { name: ENV, version: process.version },
    engine: { name: 'comunica' },
    build: { comunica, rdfStores: version('rdf-stores'), n3: version('n3'), runtime: 'node' },
    userAgent: `Node.js ${process.version} (V8 ${process.versions.v8})`,
    machine: args.machine,
    startedAt,
    finishedAt: new Date().toISOString(),
    settings: { timeoutMs, warmupRounds: args.mode === 'warmup' ? 0 : Number(args.warmup),
      rounds: args.mode === 'warmup' ? Number(args['curve-rounds']) : Number(args.rounds) },
    status: 'complete',
    load: { inflateMs, ...load },
    memory: { method: 'process.memoryUsage', heapUsedBytes: process.memoryUsage().heapUsed },
    attempts: [],
    executions,
    repetition,
  };
  writeFileSync(join(OUT, 'raw', rawName(dataset, repetition)), `${JSON.stringify(raw, null, 1)}\n`);
}

function main(): void {
  mkdirSync(join(OUT, 'raw'), { recursive: true });
  const datasets = args.datasets.split(',').filter(Boolean);
  // Repetitions are the outer loop, as in the browser runner.
  for (let repetition = 1; repetition <= Number(args.repeat); repetition++) {
    for (const dataset of datasets) {
      const name = rawName(dataset, repetition);
      if (!args.force && existsSync(join(OUT, 'raw', name))) {
        console.log(`exists ${name}`);
        continue;
      }
      console.log(`run ${name}`);
      const status = spawnSync(process.execPath, [ '--expose-gc', '--max-old-space-size=8192', '--import', 'tsx',
        import.meta.filename, ...process.argv.slice(2), '--child', `${dataset}:${repetition}` ], { stdio: 'inherit' });
      if (status.status !== 0) {
        console.error(`${name}: child exited with ${status.status ?? status.signal}`);
      }
    }
  }
  const metaFile = join(OUT, 'meta.json');
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : { machine: { label: args.machine } };
  meta.browsers = { ...meta.browsers, [ENV]: process.version };
  meta.nodeRunner = { ...meta.nodeRunner, [ENV]: { node: process.version, v8: process.versions.v8, args: process.argv.slice(2),
    comunica: JSON.parse(readFileSync(join(ROOT, '.cache', 'comunica-build.json'), 'utf8')).commit,
    updatedAt: new Date().toISOString() } };
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Results in ${OUT}`);
}

if (args.child) {
  const [ dataset, repetition ] = args.child.split(':');
  await child(dataset, Number(repetition));
} else {
  main();
}
