// Quick per-template comparison of Comunica and Oxigraph in one Node process, for iterating on Comunica changes:
// loads each dataset into both engines as the benchmark does, runs --warmup rounds over the selected queries, then
// --rounds timed rounds (queries in order within a round), and checks every count against reference.json.
// Per instance it takes the median over the timed rounds; per template the mean of those, and the ratio
// Comunica ÷ Oxigraph as the geometric mean over its instances. Oxigraph's numbers can be cached (--oxigraph-cache)
// so that an iteration only reruns Comunica.
// Usage: npx tsx scripts/quick-compare.ts [--datasets watdiv-1,watdiv-10] [--exclude C1,C2,C3] [--templates F,L]
//   [--warmup 10] [--rounds 10] [--engines comunica,oxigraph] [--oxigraph-cache file.json] [--out file.json]
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { Store } from 'oxigraph/node.js';
import { DataFactory } from 'rdf-data-factory';
import { loadOrderedStore, runComunicaQuery } from '../src/adapters/comunica';
import { runOxigraphQuery } from '../src/adapters/oxigraph-query';
import type { OxigraphStoreLike } from '../src/adapters/oxigraph-query';
import { readChunks } from '../src/node-chunks';

// The lite engine's typings do not declare queryBindings, which QueryEngineBase provides.
type QueryBindings = (query: unknown, context: Record<string, unknown>) => Promise<{ toArray: () => Promise<unknown[]> }>;

const ROOT = resolve(import.meta.dirname, '..');
const { values: args } = parseArgs({
  options: {
    datasets: { type: 'string', default: 'watdiv-1,watdiv-10' },
    exclude: { type: 'string', default: 'C1,C2,C3' },
    templates: { type: 'string', default: '' },
    warmup: { type: 'string', default: '10' },
    rounds: { type: 'string', default: '10' },
    engines: { type: 'string', default: 'comunica,oxigraph' },
    'oxigraph-cache': { type: 'string' },
    // Pass Comunica the algebra (translated once, outside the timing) instead of the query string.
    preparsed: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const template = (q: string) => q.replace(/-\d+$/u, '');
const median = (xs: number[]) => {
  const s = [ ...xs ].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
type Times = Record<string, number>;

async function measure(run: (text: string) => Promise<number>, queries: string[], texts: string[]): Promise<Times> {
  const samples: number[][] = queries.map(() => []);
  for (let round = 0; round < Number(args.warmup) + Number(args.rounds); round++) {
    for (const [ i, text ] of texts.entries()) {
      const start = performance.now();
      const count = await run(text);
      const ms = performance.now() - start;
      if (count !== expected[queries[i]]) {
        throw new Error(`${queries[i]}: ${count} results, expected ${expected[queries[i]]}`);
      }
      if (round >= Number(args.warmup)) {
        samples[i].push(ms);
      }
    }
  }
  return Object.fromEntries(queries.map((q, i) => [ q, median(samples[i]) ]));
}

let expected: Record<string, number> = {};
const engines = args.engines.split(',');
const cacheFile = args['oxigraph-cache'] && resolve(args['oxigraph-cache']);
const cache: Record<string, Times> = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const results: Record<string, Record<string, Times>> = {};
for (const dataset of args.datasets.split(',')) {
  const dir = join(ROOT, 'data', dataset, 'queries');
  const prefixes = args.templates.split(',').filter(Boolean);
  const excluded = args.exclude.split(',').filter(Boolean);
  const queries = readdirSync(dir).filter(f => f.endsWith('.sparql')).map(f => f.replace(/\.sparql$/u, ''))
    .filter(q => (prefixes.length === 0 || prefixes.some(p => template(q).startsWith(p))) && !excluded.includes(template(q)))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const texts = queries.map(q => readFileSync(join(dir, `${q}.sparql`), 'utf8'));
  const reference = JSON.parse(readFileSync(join(ROOT, 'data', dataset, 'reference.json'), 'utf8')).queries;
  expected = Object.fromEntries(queries.map(q => [ q, reference[q].count ]));
  const chunks = readChunks(join(ROOT, 'data', dataset, 'dataset.nt.gz'));
  results[dataset] = {};
  if (engines.includes('comunica')) {
    const { store } = loadOrderedStore(chunks);
    const engine = new QueryEngine();
    let run = async(text: string): Promise<number> => (await runComunicaQuery(engine, store, text, 60_000)).count;
    if (args.preparsed) {
      const parseReq = createRequire(join(realpathSync(join(ROOT, 'node_modules', '@comunica', 'query-sparql-rdfjs-lite')),
        '..', '..', 'packages', 'actor-query-parse-sparql', 'package.json'));
      const { Parser } = parseReq('@traqula/parser-sparql-1-2');
      const { toAlgebra } = parseReq('@traqula/algebra-sparql-1-2');
      const { AstFactory } = parseReq('@traqula/rules-sparql-1-2');
      const dataFactory = new DataFactory();
      const algebras = new Map(texts.map(text => [ text, toAlgebra(new Parser().parse(text, { astFactory: new AstFactory() }),
        { quads: true, blankToVariable: true, dataFactory }) ]));
      run = async text => (await (await (engine as unknown as { queryBindings: QueryBindings }).queryBindings(algebras.get(text), { sources: [ store ]})).toArray()).length;
    }
    results[dataset].comunica = await measure(run, queries, texts);
  }
  if (engines.includes('oxigraph')) {
    const store = new Store();
    store.load(chunks, { format: 'application/n-triples' });
    results[dataset].oxigraph = await measure(async text =>
      runOxigraphQuery(store as unknown as OxigraphStoreLike, text).count, queries, texts);
    if (cacheFile) {
      cache[dataset] = { ...cache[dataset], ...results[dataset].oxigraph };
      writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
    }
  } else if (cache[dataset]) {
    results[dataset].oxigraph = Object.fromEntries(queries.filter(q => q in cache[dataset]).map(q => [ q, cache[dataset][q] ]));
  }
  const c = results[dataset].comunica;
  const o = results[dataset].oxigraph;
  if (!c || !o) {
    continue;
  }
  const fmt = (x: number) => x < 10 ? x.toFixed(2) : x.toFixed(0);
  const geo = (qs: string[]) => Math.exp(qs.reduce((a, q) => a + Math.log(c[q] / o[q]), 0) / qs.length);
  console.log(`\n${dataset} (${args.warmup} warm-up, ${args.rounds} timed rounds; median per instance, ms)`);
  console.log('Template  Comunica  Oxigraph  C ÷ O');
  for (const t of [ ...new Set(queries.map(template)) ]) {
    const qs = queries.filter(q => template(q) === t);
    const mean = (x: Times) => qs.reduce((a, q) => a + x[q], 0) / qs.length;
    console.log(`${t.padEnd(8)}  ${fmt(mean(c)).padStart(8)}  ${fmt(mean(o)).padStart(8)}  ${geo(qs).toFixed(2).padStart(5)}×`);
  }
  console.log(`All       ${fmt(queries.reduce((a, q) => a + c[q], 0)).padStart(8)}  ` +
    `${fmt(queries.reduce((a, q) => a + o[q], 0)).padStart(8)}  ${geo(queries).toFixed(2).padStart(5)}×  ` +
    `(Comunica slower on ${queries.filter(q => c[q] > o[q]).length} of ${queries.length} instances)`);
}
if (args.out) {
  writeFileSync(args.out, JSON.stringify(results, null, 1));
}
