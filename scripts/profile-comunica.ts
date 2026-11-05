// CPU profile of Comunica on chosen queries, in Node, after warm-up: loads a dataset and engine as the benchmark does
// (same build, store, loader and query function), runs the queries for --warmup rounds, then records --rounds rounds
// with the V8 inspector's sampling profiler. Writes the .cpuprofile (open it in Chrome DevTools, Performance panel)
// and a summary: self time per function, and inclusive time per package (share of samples with that package anywhere
// on the stack), which shows how much goes into parsing, optimizing, joining and streaming.
// Usage: npm run profile:comunica -- --dataset watdiv-10 [--templates F,L,S] [--exclude C3] [--warmup 10]
//   [--rounds 30] [--interval 50] [--out profiles/<name>]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { loadOrderedStore, runComunicaQuery } from '../src/adapters/comunica';
import { readChunks } from '../src/node-chunks';

const ROOT = resolve(import.meta.dirname, '..');
const { values: args } = parseArgs({
  options: {
    dataset: { type: 'string', default: 'watdiv-10' },
    templates: { type: 'string', default: '' },
    exclude: { type: 'string', default: '' },
    warmup: { type: 'string', default: '10' },
    rounds: { type: 'string', default: '30' },
    interval: { type: 'string', default: '50' },
    out: { type: 'string' },
    top: { type: 'string', default: '40' },
  },
});

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
}

/** A short package label for a script URL. */
function packageOf(url: string): string {
  const monorepo = /\.cache\/comunica\/(packages|engines)\/([^/]+)\//u.exec(url);
  if (monorepo) {
    return `@comunica/${monorepo[2]}`;
  }
  const modules = [ ...url.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//gu) ].at(-1);
  if (modules) {
    return modules[1];
  }
  if (url.includes('/src/adapters/')) {
    return 'benchmark adapter';
  }
  if (url.startsWith('node:')) {
    return 'node internals';
  }
  return url === '' ? '(native or V8)' : url.replace(/^file:\/\//u, '').replace(`${ROOT}/`, '');
}

function summarize(profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }, top: number): string {
  const byId = new Map(profile.nodes.map(n => [ n.id, n ]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) {
    for (const c of n.children ?? []) {
      parent.set(c, n.id);
    }
  }
  // Time per sample from the deltas.
  const timeOf = new Map<number, number>();
  profile.samples.forEach((id, i) => timeOf.set(id, (timeOf.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const total = [ ...timeOf.values() ].reduce((a, x) => a + x, 0);
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  for (const [ id, us ] of timeOf) {
    const node = byId.get(id)!;
    const f = node.callFrame;
    const key = `${f.functionName || '(anonymous)'}  ${packageOf(f.url)}${f.url ? `:${f.lineNumber + 1}` : ''}`;
    self.set(key, (self.get(key) ?? 0) + us);
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const pkg = packageOf(byId.get(cur)!.callFrame.url);
      if (!seen.has(pkg)) {
        seen.add(pkg);
        inclusive.set(pkg, (inclusive.get(pkg) ?? 0) + us);
      }
    }
  }
  const pct = (us: number) => `${(100 * us / total).toFixed(1).padStart(5)} %`;
  const lines = [ `Total sampled: ${(total / 1000).toFixed(0)} ms`, '', 'Self time per function:' ];
  for (const [ k, us ] of [ ...self ].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    lines.push(`${pct(us)}  ${k}`);
  }
  lines.push('', 'Inclusive time per package (samples with the package anywhere on the stack):');
  for (const [ k, us ] of [ ...inclusive ].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    lines.push(`${pct(us)}  ${k}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const dataset = args.dataset;
  const dir = join(ROOT, 'data', dataset, 'queries');
  const prefixes = args.templates.split(',').filter(Boolean);
  const excluded = args.exclude.split(',').filter(Boolean);
  const template = (q: string) => q.replace(/-\d+$/u, '');
  const queries = readdirSync(dir).filter(f => f.endsWith('.sparql')).map(f => f.replace(/\.sparql$/u, ''))
    .filter(q => (prefixes.length === 0 || prefixes.some(p => template(q).startsWith(p))) && !excluded.includes(template(q)))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const texts = queries.map(q => readFileSync(join(dir, `${q}.sparql`), 'utf8'));
  const reference = JSON.parse(readFileSync(join(ROOT, 'data', dataset, 'reference.json'), 'utf8')).queries;
  const { store } = loadOrderedStore(readChunks(join(ROOT, 'data', dataset, 'dataset.nt.gz')));
  const engine = new QueryEngine();
  const round = async(): Promise<number> => {
    const start = performance.now();
    for (const [ i, text ] of texts.entries()) {
      const result = await runComunicaQuery(engine, store, text, 60_000);
      if (reference[queries[i]]?.count !== undefined && reference[queries[i]].count !== result.count) {
        throw new Error(`${queries[i]}: ${result.count} results, expected ${reference[queries[i]].count}`);
      }
    }
    return performance.now() - start;
  };
  for (let i = 0; i < Number(args.warmup); i++) {
    await round();
  }
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: Number(args.interval) });
  await session.post('Profiler.start');
  const times: number[] = [];
  for (let i = 0; i < Number(args.rounds); i++) {
    times.push(await round());
  }
  const { profile } = await session.post('Profiler.stop');
  session.disconnect();
  const out = resolve(ROOT, args.out ?? join('profiles', `${dataset}${prefixes.length > 0 ? `-${prefixes.join('')}` : ''}`));
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(`${out}.cpuprofile`, JSON.stringify(profile));
  const sorted = [ ...times ].sort((a, b) => a - b);
  const header = `${dataset}, ${queries.length} queries (${[ ...new Set(queries.map(template)) ].join(' ')}), ` +
    `${args.warmup} warm-up rounds, ${args.rounds} profiled rounds, median round ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms, ` +
    `Node ${process.version} (V8 ${process.versions.v8}), Comunica ${
      JSON.parse(readFileSync(join(ROOT, '.cache', 'comunica-build.json'), 'utf8')).commit.slice(0, 7)}`;
  const summary = `${header}\n${summarize(profile as unknown as Parameters<typeof summarize>[0], Number(args.top))}\n`;
  writeFileSync(`${out}.txt`, summary);
  console.log(summary);
}

await main();
