// Worker for src/reference.ts. Oxigraph's queries are synchronous, so they run here, where a query that does not
// finish can be stopped by terminating the worker.
import { parentPort, workerData } from 'node:worker_threads';
import oxigraph from 'oxigraph';
import { runOxigraphQuery } from './adapters/oxigraph-query';
import type { OxigraphStoreLike } from './adapters/oxigraph-query';
import { readChunks } from './node-chunks';

const store = new oxigraph.Store();
store.load(readChunks(workerData.file), { format: 'application/n-triples' });
parentPort!.on('message', ({ id, query }: { id: string; query: string }) => {
  try {
    const result = runOxigraphQuery(store as unknown as OxigraphStoreLike, query);
    parentPort!.postMessage({ id, count: result.count, resultType: result.resultType });
  } catch (error: unknown) {
    parentPort!.postMessage({ id, count: null, error: String((error as Error).message ?? error) });
  }
});
parentPort!.postMessage({ ready: true });
