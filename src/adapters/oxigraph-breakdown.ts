// Oxigraph breakdown mode: splits a query's time into evaluation and moving its results into JavaScript.
// Loaded on demand by the Oxigraph adapter, so it is not part of the page's bundle size.
import type { QueryResult, TermLike } from './types';
import type { OxigraphQuadLike, OxigraphStoreLike } from './oxigraph-query';

/** The timing runs' own consumption function, passed in so that this chunk does not import the adapter chunk. */
type RunQuery = (store: OxigraphStoreLike, sparql: string) => QueryResult;

/**
 * Variants for the Oxigraph breakdown mode, which splits a query's time into evaluation and moving its results into
 * JavaScript. Each variant times itself; `terms` is counted outside the timed part.
 * - `count`:   SELECT (COUNT(*) AS ?n) WHERE { { <query> } }. Oxigraph evaluates the query, only one number crosses
 *              into JavaScript. Optimizations the wrapper allows (e.g. dropping an ORDER BY without LIMIT) make this a
 *              lower bound on evaluation. SELECT queries only.
 * - `objects`: store.query(q): evaluation plus building the JS result (a Map and wrapper object per term), unread.
 * - `full`:    store.query(q) plus reading every term, exactly as the timing runs measure (runOxigraphQuery).
 * - `json`:    the result serialized inside WASM as SPARQL JSON (N-Triples for graph results), handed over as one
 *              string, then JSON.parse and every value read (graph results: lines counted).
 */
export const BREAKDOWN_VARIANTS = [ 'count', 'objects', 'full', 'json' ] as const;
export type BreakdownVariant = typeof BREAKDOWN_VARIANTS[number];

interface OxigraphQueryStore {
  query: (query: string, options?: { results_format?: string }) => unknown;
}

const PROLOGUE = /^(?:\s*(?:#[^\n]*|PREFIX\s+[\w.-]*:\s*<[^>]*>|BASE\s+<[^>]*>))*/iu;

/** The query form, from the first keyword after the prologue. */
export function queryForm(sparql: string): 'SELECT' | 'CONSTRUCT' | 'DESCRIBE' | 'ASK' | 'OTHER' {
  const keyword = /^\s*(\w+)/u.exec(sparql.slice(PROLOGUE.exec(sparql)![0].length))?.[1]?.toUpperCase();
  return keyword === 'SELECT' || keyword === 'CONSTRUCT' || keyword === 'DESCRIBE' || keyword === 'ASK' ? keyword : 'OTHER';
}

/** Wraps a SELECT query so that only the number of its solutions is returned. */
export function countQuery(sparql: string): string {
  const prologue = PROLOGUE.exec(sparql)![0];
  return `${prologue}\nSELECT (COUNT(*) AS ?benchmarkCount) WHERE { { ${sparql.slice(prologue.length)} } }`;
}

export function runOxigraphVariant(
  store: OxigraphQueryStore,
  variant: BreakdownVariant,
  sparql: string,
  runOxigraphQuery: RunQuery,
): QueryResult & { ms: number; terms?: number } {
  switch (variant) {
    case 'count': {
      if (queryForm(sparql) !== 'SELECT') {
        throw new Error('The count variant applies to SELECT queries only');
      }
      const t0 = performance.now();
      const rows = store.query(countQuery(sparql)) as Map<string, TermLike>[];
      const count = Number(rows[0].get('benchmarkCount')!.value);
      const ms = performance.now() - t0;
      return { count, checksum: 0, resultType: 'bindings', ms };
    }
    case 'objects': {
      const t0 = performance.now();
      const result = store.query(sparql);
      const ms = performance.now() - t0;
      if (typeof result === 'boolean') {
        return { count: result ? 1 : 0, checksum: 0, resultType: 'boolean', ms, terms: 0 };
      }
      const items = result as (Map<string, TermLike> | OxigraphQuadLike)[];
      const terms = items.reduce((sum, item) => sum + (item instanceof Map ? item.size : 4), 0);
      return { count: items.length, checksum: 0, resultType: items[0] instanceof Map || items.length === 0 ? 'bindings' : 'quads', ms, terms };
    }
    case 'full': {
      const t0 = performance.now();
      const result = runOxigraphQuery(store as OxigraphStoreLike, sparql);
      return { ...result, ms: performance.now() - t0 };
    }
    case 'json': {
      const form = queryForm(sparql);
      if (form === 'CONSTRUCT' || form === 'DESCRIBE') {
        return runOxigraphGraphJson(store, sparql);
      }
      const t0 = performance.now();
      const serialized = store.query(sparql, { results_format: 'application/sparql-results+json' }) as string;
      const parsed = JSON.parse(serialized) as { boolean?: boolean; results?: { bindings: Record<string, { value: string }>[] } };
      let count = 0;
      let checksum = 0;
      if (typeof parsed.boolean === 'boolean') {
        const ms = performance.now() - t0;
        return { count: parsed.boolean ? 1 : 0, checksum: 0, resultType: 'boolean', ms };
      }
      for (const binding of parsed.results!.bindings) {
        count++;
        for (const key in binding) {
          checksum += binding[key].value.length;
        }
      }
      const ms = performance.now() - t0;
      return { count, checksum, resultType: 'bindings', ms };
    }
  }
}

/** Graph results (CONSTRUCT, DESCRIBE) cannot be serialized as SPARQL JSON; they go out as N-Triples. */
export function runOxigraphGraphJson(store: OxigraphQueryStore, sparql: string): QueryResult & { ms: number } {
  const t0 = performance.now();
  const serialized = store.query(sparql, { results_format: 'application/n-triples' }) as string;
  let count = 0;
  for (let i = serialized.indexOf('\n'); i >= 0; i = serialized.indexOf('\n', i + 1)) {
    count++;
  }
  const ms = performance.now() - t0;
  return { count, checksum: serialized.length, resultType: 'quads', ms };
}
