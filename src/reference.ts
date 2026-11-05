// Reference result counts: runs every query in Node against Oxigraph and against Comunica (same store setup
// as in the browser) and writes data/<name>/reference.json. Disagreements are recorded, never resolved.
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { loadOrderedStore, runComunicaQuery } from './adapters/comunica';
import { readChunks } from './node-chunks';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'data');
// Generous, since these runs only establish counts; the same client-side timeout as comunica/Experiments-Centralized#7.
const TIMEOUT_MS = Number(process.env.REFERENCE_TIMEOUT_MS ?? 300_000);

interface Count {
  count: number | null;
  resultType?: string;
  error?: string;
}

const version = (name: string) => JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;

/** Progress on stderr for long runs; these Node timings are not results and are not stored. */
function progress(engine: string, id: string, count: number, ms: number): void {
  if (process.env.REFERENCE_VERBOSE) {
    process.stderr.write(`  ${engine} ${id}: ${count} (${ms.toFixed(0)} ms)\n`);
  }
}

function queriesOf(dataset: string): [string, string][] {
  const dir = join(DATA, dataset, 'queries');
  return readdirSync(dir).filter(f => f.endsWith('.sparql'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map(f => [ f.replace(/\.sparql$/u, ''), readFileSync(join(dir, f), 'utf8') ]);
}

/**
 * Oxigraph's counts, from a worker thread that is terminated (and restarted for the next query) when a query
 * exceeds the timeout: its synchronous query call cannot be interrupted otherwise.
 */
async function oxigraphCounts(file: string, queries: [string, string][]): Promise<Map<string, Count>> {
  const counts = new Map<string, Count>();
  let worker: Worker | undefined;
  for (const [ id, query ] of queries) {
    if (!worker) {
      worker = new Worker(new URL('./reference-oxigraph-worker.ts', import.meta.url), {
        workerData: { file },
        execArgv: [ '--import', 'tsx' ],
      });
      await once(worker, 'message');
    }
    const t0 = performance.now();
    const current = worker;
    const reply = once(current, 'message').then(([ message ]) => message as Count);
    current.postMessage({ id, query });
    const timer = new AbortController();
    const result = await Promise.race([
      reply,
      delay(TIMEOUT_MS, undefined, { signal: timer.signal }).catch(() => undefined),
    ]);
    timer.abort();
    if (result === undefined) {
      await current.terminate();
      worker = undefined;
      counts.set(id, { count: null, error: `timeout after ${TIMEOUT_MS} ms` });
      process.stderr.write(`  oxigraph ${id}: timeout after ${TIMEOUT_MS} ms\n`);
      continue;
    }
    counts.set(id, result.count === null ? { count: null, error: result.error } : { count: result.count, resultType: result.resultType });
    if (result.count !== null) {
      progress('oxigraph', id, result.count, performance.now() - t0);
    }
  }
  await worker?.terminate();
  return counts;
}

async function referenceFor(dataset: string): Promise<boolean> {
  const file = join(DATA, dataset, 'dataset.nt.gz');
  const queries = queriesOf(dataset);
  console.log(`${dataset}: ${queries.length} queries`);

  const oxigraphResults = await oxigraphCounts(file, queries);

  const comunicaCounts = new Map<string, Count>();
  {
    const { store } = loadOrderedStore(readChunks(file));
    const engine = new QueryEngine();
    for (const [ id, query ] of queries) {
      try {
        const t0 = performance.now();
        const result = await runComunicaQuery(engine, store, query, TIMEOUT_MS);
        comunicaCounts.set(id, { count: result.count, resultType: result.resultType });
        progress('comunica', id, result.count, performance.now() - t0);
      } catch (error: unknown) {
        comunicaCounts.set(id, { count: null, error: String((error as Error).message ?? error) });
      }
    }
  }

  let agreeAll = true;
  const entries: Record<string, unknown> = {};
  for (const [ id ] of queries) {
    const ox = oxigraphResults.get(id)!;
    const co = comunicaCounts.get(id)!;
    const counts = [ ox.count, co.count ].filter((c): c is number => c !== null);
    // Agreement needs both engines to answer and to give the same count. If only one answered,
    // that count is used and the entry says so; if they differ, there is no reference count.
    const agree = counts.length > 0 && counts.every(c => c === counts[0]);
    if (!agree || counts.length < 2) {
      console.log(`  ${id}: oxigraph=${ox.count ?? ox.error} comunica=${co.count ?? co.error}`);
    }
    if (!agree && counts.length === 2) {
      agreeAll = false;
    }
    entries[id] = {
      count: agree ? counts[0] : null,
      agree,
      confirmedBy: [ ox.count !== null ? 'oxigraph' : '', co.count !== null ? 'comunica' : '' ].filter(Boolean),
      oxigraph: ox,
      comunica: co,
    };
  }
  const comunicaBuild = JSON.parse(readFileSync(join(ROOT, '.cache', 'comunica-build.json'), 'utf8'));
  writeFileSync(join(DATA, dataset, 'reference.json'), `${JSON.stringify({
    dataset,
    generatedAt: new Date().toISOString(),
    node: process.version,
    engines: {
      oxigraph: version('oxigraph'),
      comunica: { commit: comunicaBuild.commit, version: comunicaBuild.packageVersion, n3: version('n3'), rdfStores: version('rdf-stores') },
    },
    agreeAll,
    queries: entries,
  }, null, 2)}\n`);
  console.log(`  ${agreeAll ? 'all counts agree' : 'DISAGREEMENT between engines'} -> data/${dataset}/reference.json`);
  return agreeAll;
}

const datasets = process.argv.slice(2).length > 0 ?
  process.argv.slice(2) :
  readdirSync(DATA).filter(name => existsSync(join(DATA, name, 'dataset.nt.gz')));
let ok = true;
for (const dataset of datasets) {
  ok = await referenceFor(dataset) && ok;
}
if (!ok) {
  console.error('Oxigraph and Comunica disagree on at least one query; see the lines above. Not picking a side.');
  process.exit(1);
}
