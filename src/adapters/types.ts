/** Timings of loading N-Triples text into an engine, taken with performance.now(). */
export interface LoadResult {
  /** Parsing time; null when the engine parses and ingests in one inseparable call. */
  parseMs: number | null;
  /** Time to move parsed data into the engine's own storage (0 if queried in place). */
  ingestMs: number;
  /** Number of quads in the store after loading. */
  quads: number;
  /** Finer-grained sub-timings, published in the raw output. */
  details: Record<string, number>;
}

/** Result of one fully consumed query execution. */
export interface QueryResult {
  /** Number of solutions, quads, or 1/0 for ASK. */
  count: number;
  /** Sum of the lengths of all term values that were read; a cheap sanity value. */
  checksum: number;
  resultType: 'bindings' | 'quads' | 'boolean';
}

/** Characters per chunk of N-Triples text handed to the engines. */
export const CHUNK_CHARS = 16 * 1024 * 1024;

export class QueryTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`Query exceeded ${timeoutMs} ms`);
    this.name = 'QueryTimeoutError';
  }
}

export interface EngineAdapter {
  readonly id: 'comunica' | 'oxigraph';
  init: () => Promise<void>;
  /**
   * Loads N-Triples text, given as line-aligned chunks (one string can hold at most ~512 MB in V8).
   * Chunks are consumed in order and may be released once consumed.
   */
  load: (chunks: Iterable<string>) => Promise<LoadResult>;
  /** Executes a query and resolves once every result term has been read. */
  query: (sparql: string, timeoutMs: number) => Promise<QueryResult>;
  /** Bytes of WebAssembly memory held by the engine, or null if it uses none. */
  wasmMemoryBytes: () => number | null;
}

/** Minimal shape of an RDF/JS term, shared by both engines' term objects. */
export interface TermLike {
  termType: string;
  value: string;
}

/** Reads a term the way an application would, returning the length of what was read. */
export function touchTerm(term: TermLike | undefined | null): number {
  if (!term) {
    return 0;
  }
  // Reading termType and value materialises lazily decoded terms (Oxigraph's are WASM-backed).
  return term.termType.length > 0 ? term.value.length : 0;
}
