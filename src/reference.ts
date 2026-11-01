// Reference result counts: runs every query in Node against Oxigraph and against Comunica (same store setup
// as in the browser) and writes data/<name>/reference.json. Disagreements are recorded, never resolved.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import oxigraph from 'oxigraph';
import { loadOrderedStore, runComunicaQuery } from './adapters/comunica';
import { runOxigraphQuery } from './adapters/oxigraph-query';
import type { OxigraphStoreLike } from './adapters/oxigraph-query';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'data');
// Generous: these runs only establish counts. Oxigraph queries are synchronous and cannot be interrupted.
const TIMEOUT_MS = Number(process.env.REFERENCE_TIMEOUT_MS ?? 600_000);

interface Count {
  count: number | null;
  resultType?: string;
  error?: string;
}

const version = (name: string) => JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;

function queriesOf(dataset: string): [string, string][] {
  const dir = join(DATA, dataset, 'queries');
  return readdirSync(dir).filter(f => f.endsWith('.sparql'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map(f => [ f.replace(/\.sparql$/u, ''), readFileSync(join(dir, f), 'utf8') ]);
}

async function referenceFor(dataset: string): Promise<boolean> {
  const nt = gunzipSync(readFileSync(join(DATA, dataset, 'dataset.nt.gz'))).toString('utf8');
  const queries = queriesOf(dataset);
  console.log(`${dataset}: ${queries.length} queries`);

  const oxigraphCounts = new Map<string, Count>();
  {
    const store = new oxigraph.Store();
    store.load(nt, { format: 'application/n-triples' });
    for (const [ id, query ] of queries) {
      try {
        const result = runOxigraphQuery(store as unknown as OxigraphStoreLike, query);
        oxigraphCounts.set(id, { count: result.count, resultType: result.resultType });
      } catch (error: unknown) {
        oxigraphCounts.set(id, { count: null, error: String((error as Error).message ?? error) });
      }
    }
    (store as unknown as { free: () => void }).free();
  }

  const comunicaCounts = new Map<string, Count>();
  {
    const { store } = loadOrderedStore(nt);
    const engine = new QueryEngine();
    for (const [ id, query ] of queries) {
      try {
        const result = await runComunicaQuery(engine, store, query, TIMEOUT_MS);
        comunicaCounts.set(id, { count: result.count, resultType: result.resultType });
      } catch (error: unknown) {
        comunicaCounts.set(id, { count: null, error: String((error as Error).message ?? error) });
      }
    }
  }

  let agreeAll = true;
  const entries: Record<string, unknown> = {};
  for (const [ id ] of queries) {
    const ox = oxigraphCounts.get(id)!;
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
