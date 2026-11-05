// Per-template phase times of Comunica in Node, after warm-up: SPARQL parsing (traqula, as ActorQueryParseSparql
// does it), translation to algebra, the whole (engine as unknown as { queryBindings: QueryBindings }).queryBindings() call (parse, optimize and the start of
// evaluation), and consuming the results. Medians over --rounds rounds per instance, mean over instances per
// template, in µs. --explain prints the physical plan of the first instance of each template, through the physical
// plan logger, which the lite engine has no explain actor for.
// Usage: npx tsx scripts/phases-comunica.ts [--dataset watdiv-1] [--exclude C1,C2,C3] [--warmup 10] [--rounds 20]
//   [--explain]
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { DataFactory } from 'rdf-data-factory';
import { loadOrderedStore } from '../src/adapters/comunica';
import { readChunks } from '../src/node-chunks';

// The lite engine's typings do not declare queryBindings, which QueryEngineBase provides.
type QueryBindings = (query: unknown, context: Record<string, unknown>) => Promise<{ toArray: () => Promise<unknown[]> }>;

const ROOT = resolve(import.meta.dirname, '..');
const { values: args } = parseArgs({
  options: {
    dataset: { type: 'string', default: 'watdiv-1' },
    exclude: { type: 'string', default: 'C1,C2,C3' },
    warmup: { type: 'string', default: '10' },
    rounds: { type: 'string', default: '20' },
    explain: { type: 'boolean', default: false },
  },
});
// Traqula as the engine resolves it.
const parseReq = createRequire(join(realpathSync(join(ROOT, 'node_modules', '@comunica', 'query-sparql-rdfjs-lite')),
  '..', '..', 'packages', 'actor-query-parse-sparql', 'package.json'));
const { Parser } = parseReq('@traqula/parser-sparql-1-2');
const { toAlgebra } = parseReq('@traqula/algebra-sparql-1-2');
const { AstFactory } = parseReq('@traqula/rules-sparql-1-2');

const template = (q: string) => q.replace(/-\d+$/u, '');
const median = (xs: number[]) => [ ...xs ].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const dir = join(ROOT, 'data', args.dataset, 'queries');
const excluded = args.exclude.split(',').filter(Boolean);
const queries = readdirSync(dir).filter(f => f.endsWith('.sparql')).map(f => f.replace(/\.sparql$/u, ''))
  .filter(q => !excluded.includes(template(q))).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const texts = queries.map(q => readFileSync(join(dir, `${q}.sparql`), 'utf8'));
const { store } = loadOrderedStore(readChunks(join(ROOT, 'data', args.dataset, 'dataset.nt.gz')));
const engine = new QueryEngine();
const parser = new Parser({ lexerConfig: { positionTracking: 'full' }});
const dataFactory = new DataFactory();

const phases = [ 'parse', 'algebra', 'query()', 'consume', 'total' ] as const;
// Comunica builds instrumented to add their own timings to globalThis.__phases (for example per mediator) have
// those listed below the table, as a mean per instance.
const T: Record<string, number> = {};
(globalThis as any).__phases = T;
const samples = queries.map(() => Object.fromEntries(phases.map(p => [ p, [] as number[] ])));
for (let round = 0; round < Number(args.warmup) + Number(args.rounds); round++) {
  for (const [ i, text ] of texts.entries()) {
    const t0 = performance.now();
    const ast = parser.parse(text, { astFactory: new AstFactory() });
    const t1 = performance.now();
    toAlgebra(ast, { quads: true, blankToVariable: true, dataFactory });
    const t2 = performance.now();
    for (const k of Object.keys(T)) {
      T[k] = 0;
    }
    const result = await (engine as unknown as { queryBindings: QueryBindings }).queryBindings(text, { sources: [ store ]});
    const t3 = performance.now();
    await result.toArray();
    const t4 = performance.now();
    if (round >= Number(args.warmup)) {
      const s = samples[i];
      s.parse.push(t1 - t0);
      s.algebra.push(t2 - t1);
      s['query()'].push(t3 - t2);
      s.consume.push(t4 - t3);
      s.total.push(t4 - t2);
      for (const k of Object.keys(T)) {
        (s[k] ??= []).push(T[k]);
      }
    }
  }
}
console.log(`${args.dataset}: µs per instance (median over ${args.rounds} rounds, mean per template); ` +
  'query() includes parsing again');
console.log(`Template ${phases.map(p => p.slice(0, 8).padStart(8)).join(' ')}`);
const all = Object.fromEntries(phases.map(p => [ p, 0 ]));
for (const t of [ ...new Set(queries.map(template)) ]) {
  const idx = queries.flatMap((q, i) => template(q) === t ? [ i ] : []);
  const row = phases.map((p) => {
    const v = idx.reduce((a, i) => a + median(samples[i][p]), 0) / idx.length;
    all[p] += v * idx.length;
    return (1000 * v).toFixed(0).padStart(8);
  });
  console.log(`${t.padEnd(8)} ${row.join(' ')}`);
}
// Every other key the instrumentation recorded, as a mean over all instances.
const extraKeys = new Set<string>();
for (const s of samples) for (const k of Object.keys(s)) if (!(phases as readonly string[]).includes(k)) extraKeys.add(k);
console.log(`${'mean'.padEnd(8)} ${phases.map(p => (1000 * all[p] / queries.length).toFixed(0).padStart(8)).join(' ')}`);
for (const k of [ ...extraKeys ].sort((a, b) => samples.reduce((x, s) => x + median(s[b] ?? [ 0 ]), 0) -
  samples.reduce((x, s) => x + median(s[a] ?? [ 0 ]), 0))) {
  console.log(`  ${(1000 * samples.reduce((x, s) => x + median(s[k] ?? [ 0 ]), 0) / samples.length).toFixed(1).padStart(7)} µs  ${k}`);
}
if (args.explain) {
  // The lite engine has no explain actor; the physical plan logger is a context entry that the operators log into.
  const explainReq = createRequire(join(realpathSync(join(ROOT, 'node_modules', '@comunica', 'query-sparql-rdfjs-lite')),
    '..', '..', 'packages', 'actor-query-process-explain-physical', 'package.json'));
  const { MemoryPhysicalQueryPlanLogger } = explainReq('./lib/MemoryPhysicalQueryPlanLogger');
  for (const t of [ ...new Set(queries.map(template)) ]) {
    const i = queries.findIndex(q => template(q) === t);
    const logger = new MemoryPhysicalQueryPlanLogger();
    const result = await (engine as unknown as { queryBindings: QueryBindings }).queryBindings(texts[i], { sources: [ store ],
      '@comunica/actor-init-query:physicalQueryPlanLogger': logger });
    const n = (await result.toArray()).length;
    await logger.finalize();
    console.log(`\n## ${queries[i]} (${n} results)\n${texts[i].trim()}\n${logger.toCompactString(true)}`);
  }
}
