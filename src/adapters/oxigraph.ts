// Oxigraph WASM (web.js build) with its own in-memory store.
import init, { Store } from 'oxigraph/web.js';
import type { EngineAdapter } from './types';
import { runOxigraphQuery } from './oxigraph-query';
import type { OxigraphStoreLike } from './oxigraph-query';

export function createAdapter(): EngineAdapter {
  let memory: WebAssembly.Memory | undefined;
  let store: Store | undefined;
  return {
    id: 'oxigraph',
    async init() {
      memory = (await init()).memory;
    },
    async load(chunks) {
      const t0 = performance.now();
      store = new Store();
      // Parsing and insertion happen inside one WASM call and cannot be timed separately. The chunks are one
      // N-Triples document to Oxigraph, which reads them in order.
      store.load(chunks, { format: 'application/n-triples' });
      const t1 = performance.now();
      return { parseMs: null, ingestMs: t1 - t0, quads: store.size, details: { storeLoadMs: t1 - t0 }};
    },
    async query(sparql) {
      return runOxigraphQuery(store as unknown as OxigraphStoreLike, sparql);
    },
    wasmMemoryBytes: () => memory?.buffer.byteLength ?? null,
  };
}
