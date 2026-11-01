// Comunica SPARQL RDF/JS Lite (built from a comunica master checkout) over an ordered rdf-stores store.
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { compareTerms } from '@comunica/utils-iterator';
import type * as RDF from '@rdfjs/types';
import { Parser } from 'n3';
import { RdfStore } from 'rdf-stores';
import type { EngineAdapter, LoadResult, QueryResult } from './types';
import { QueryTimeoutError, touchTerm } from './types';

/** The store that comunica/comunica#1839 loads files into: GSOP, GPSO and GOPS indexes in term order. */
export function createOrderedStore(): RdfStore {
  return RdfStore.createOrdered({ termComparator: compareTerms, nodes: true });
}

export function loadOrderedStore(chunks: Iterable<string>): { store: RdfStore; result: LoadResult } {
  const t0 = performance.now();
  const quads: RDF.Quad[] = [];
  let count = 0;
  for (const chunk of chunks) {
    // Each chunk gets its own parser; an empty prefix keeps blank node labels, so they still join across chunks.
    for (const quad of new Parser({ format: 'N-Triples', blankNodePrefix: '' }).parse(chunk) as unknown as RDF.Quad[]) {
      quads.push(quad);
    }
    count++;
  }
  const t1 = performance.now();
  // As in #1839, all quads go into the ordered store as one batch: several smaller batches get slower as the
  // store grows (42 batches took 2.8 times as long as one for LDBC SNB 0.1 in Chromium).
  const store = createOrderedStore();
  store.addQuads(quads);
  const t2 = performance.now();
  const n3ParseMs = t1 - t0;
  const storeBuildMs = t2 - t1;
  return {
    store,
    result: {
      // The RDF/JS store is what Comunica queries, so building it is part of parsing; there is no ingest step.
      parseMs: n3ParseMs + storeBuildMs,
      ingestMs: 0,
      quads: store.size,
      details: { n3ParseMs, storeBuildMs, chunks: count },
    },
  };
}

function consume<T>(
  stream: RDF.ResultStream<T> & { destroy: (cause?: Error) => void },
  onItem: (item: T) => void,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new QueryTimeoutError(timeoutMs));
    }, timeoutMs);
    stream.on('data', onItem);
    stream.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function runComunicaQuery(
  engine: QueryEngine,
  store: RDF.Store,
  sparql: string,
  timeoutMs: number,
): Promise<QueryResult> {
  const query = await engine.query(sparql, { sources: [ store ]});
  let count = 0;
  let checksum = 0;
  switch (query.resultType) {
    case 'bindings': {
      const stream = await query.execute();
      await consume(stream, (bindings) => {
        count++;
        for (const [ , term ] of bindings) {
          checksum += touchTerm(term);
        }
      }, timeoutMs);
      return { count, checksum, resultType: 'bindings' };
    }
    case 'quads': {
      const stream = await query.execute();
      await consume(stream, (quad) => {
        count++;
        checksum += touchTerm(quad.subject) + touchTerm(quad.predicate) + touchTerm(quad.object) +
          touchTerm(quad.graph);
      }, timeoutMs);
      return { count, checksum, resultType: 'quads' };
    }
    case 'boolean': {
      const value = await query.execute();
      return { count: value ? 1 : 0, checksum: 0, resultType: 'boolean' };
    }
    default:
      throw new Error(`Unsupported result type ${query.resultType}`);
  }
}

export function createAdapter(): EngineAdapter {
  let engine: QueryEngine | undefined;
  let store: RdfStore | undefined;
  return {
    id: 'comunica',
    async init() {
      engine = new QueryEngine();
    },
    async load(chunks) {
      const loaded = loadOrderedStore(chunks);
      store = loaded.store;
      return loaded.result;
    },
    query(sparql, timeoutMs) {
      return runComunicaQuery(engine!, store!, sparql, timeoutMs);
    },
    wasmMemoryBytes: () => null,
  };
}
