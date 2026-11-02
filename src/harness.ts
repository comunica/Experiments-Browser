// In-page benchmark harness: fetch+inflate, engine init, load, memory, then the support/cold/warmup/timed steps.
// Every timing is taken here with performance.now(); the runner only receives the numbers.
import type { EngineAdapter } from './adapters/types';
import { CHUNK_CHARS, QueryTimeoutError } from './adapters/types';
import type { BenchConfig, BenchEvent, ExecResult, LoadInfo, MemoryInfo, Outcome } from './protocol';
import { UNSUPPORTED_PATTERN } from './protocol';

declare const __BENCH_BUILD__: unknown;

interface ReferenceFile {
  queries: Record<string, { count: number | null; agree: boolean }>;
}

declare global {
  interface Window {
    __BENCH_CONFIG__?: BenchConfig;
    __benchEvent?: (event: BenchEvent) => Promise<unknown>;
    __benchLog?: BenchEvent[];
    gc?: () => void;
  }
}

type AdapterModule = { createAdapter: () => EngineAdapter };

const log: BenchEvent[] = [];
window.__benchLog = log;

async function emit(event: BenchEvent): Promise<void> {
  log.push(event);
  if (window.__benchEvent) {
    await window.__benchEvent(event);
  } else {
    console.log(JSON.stringify(event));
  }
}

/** Configuration from the runner, or from the URL when a page is opened by hand. */
function readConfig(): BenchConfig {
  if (window.__BENCH_CONFIG__) {
    return window.__BENCH_CONFIG__;
  }
  const params = new URLSearchParams(location.search);
  const queries = (params.get('queries') ?? '').split(',').filter(Boolean);
  return {
    dataset: params.get('dataset') ?? 'smoke',
    engine: params.get('engine') ?? 'manual',
    measureMemory: params.has('memory'),
    timeoutMs: Number(params.get('timeout') ?? 60_000),
    steps: queries.map(query => ({ phase: 'support', round: 0, query })),
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.text();
}

/**
 * Inflates gzipped N-Triples into line-aligned string chunks of about CHUNK_CHARS characters,
 * since a large dataset does not fit in one string. Returns the chunks and the number of inflated bytes.
 */
async function inflateToChunks(gz: ArrayBuffer): Promise<{ chunks: string[]; bytes: number }> {
  const reader = new Blob([ gz ]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let pending: string[] = [];
  let pendingLength = 0;
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
    bytes += value?.byteLength ?? 0;
    if (text) {
      pending.push(text);
      pendingLength += text.length;
    }
    if (pendingLength >= CHUNK_CHARS || (done && pendingLength > 0)) {
      // Browsers hand over inflated data in pieces of very different sizes (WebKit can return all of it at once).
      const joined = pending.join('');
      let start = 0;
      while (joined.length - start >= CHUNK_CHARS) {
        const newline = joined.indexOf('\n', start + CHUNK_CHARS - 1);
        if (newline < 0) {
          break;
        }
        chunks.push(joined.slice(start, newline + 1));
        start = newline + 1;
      }
      if (done && start < joined.length) {
        chunks.push(joined.slice(start));
        start = joined.length;
      }
      const rest = joined.slice(start);
      pending = rest ? [ rest ] : [];
      pendingLength = rest.length;
    }
    if (done) {
      return { chunks, bytes };
    }
  }
}

/** Yields the chunks and drops each from the array once handed out, so the engine's GC can reclaim them. */
function* drain(chunks: (string | undefined)[]): Generator<string> {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    chunks[i] = undefined;
    yield chunk;
  }
}

async function measureMemory(adapter: EngineAdapter): Promise<MemoryInfo> {
  // Drop garbage from loading (text, parsed arrays) so only what the engine keeps is counted.
  for (let i = 0; i < 3; i++) {
    window.gc?.();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const wasmBytes = adapter.wasmMemoryBytes();
  const usedJSHeapSize = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  const measure = (performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number; breakdown: unknown }> })
    .measureUserAgentSpecificMemory;
  if (!measure) {
    return { method: 'none', bytes: null, wasmBytes, usedJSHeapSize, failure: 'measureUserAgentSpecificMemory unavailable' };
  }
  if (!crossOriginIsolated) {
    return { method: 'none', bytes: null, wasmBytes, usedJSHeapSize, failure: 'page is not cross-origin isolated' };
  }
  try {
    const result = await Promise.race([
      measure.call(performance),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out after 60 s')), 60_000)),
    ]);
    return { method: 'measureUserAgentSpecificMemory', bytes: result.bytes, wasmBytes, usedJSHeapSize, breakdown: result.breakdown };
  } catch (error: unknown) {
    return { method: 'none', bytes: null, wasmBytes, usedJSHeapSize, failure: String(error) };
  }
}

function classifyError(error: unknown): Outcome {
  if (error instanceof QueryTimeoutError) {
    return 'timeout';
  }
  return UNSUPPORTED_PATTERN.test(String((error as Error)?.message ?? error)) ? 'unsupported' : 'error';
}

export async function main(loadAdapter: () => Promise<AdapterModule>): Promise<void> {
  try {
    await run(loadAdapter);
  } catch (error: unknown) {
    await emit({ type: 'fatal', error: String((error as Error)?.stack ?? error) });
  }
}

async function run(loadAdapter: () => Promise<AdapterModule>): Promise<void> {
  const config = readConfig();
  await emit({ type: 'build', build: __BENCH_BUILD__, userAgent: navigator.userAgent, crossOriginIsolated });

  // Queries and reference counts are fetched before anything is timed.
  const base = `../data/${config.dataset}`;
  const queryIds = [ ...new Set(config.steps.map(step => step.query)) ];
  const queries = new Map(await Promise.all(queryIds.map(async id =>
    <const>[ id, await fetchText(`${base}/queries/${id}.sparql`) ])));
  let reference: ReferenceFile | undefined;
  try {
    reference = JSON.parse(await fetchText(`${base}/reference.json`));
  } catch {
    reference = undefined;
  }

  // Fetch + inflate: not charged to the engine.
  let t0 = performance.now();
  const response = await fetch(`${base}/dataset.nt.gz`);
  if (!response.ok) {
    throw new Error(`dataset: HTTP ${response.status}`);
  }
  const gz = await response.arrayBuffer();
  let t1 = performance.now();
  const fetchMs = t1 - t0;
  t0 = performance.now();
  const inflated = await inflateToChunks(gz);
  t1 = performance.now();
  const inflateMs = t1 - t0;
  const ntBytes = inflated.bytes;

  // Engine init: loading the adapter chunk (JS, and WASM for Oxigraph) and constructing the engine.
  t0 = performance.now();
  const module = await loadAdapter();
  t1 = performance.now();
  const importMs = t1 - t0;
  const adapter = module.createAdapter();
  t0 = performance.now();
  await adapter.init();
  t1 = performance.now();
  const initMs = t1 - t0;

  const loaded = await adapter.load(drain(inflated.chunks));
  inflated.chunks.length = 0;
  const load: LoadInfo = {
    fetchMs,
    inflateMs,
    importMs,
    initMs,
    parseMs: loaded.parseMs,
    ingestMs: loaded.ingestMs,
    loadMs: (loaded.parseMs ?? 0) + loaded.ingestMs,
    quads: loaded.quads,
    ntBytes,
    gzBytes: gz.byteLength,
    details: loaded.details,
  };
  await emit({ type: 'loaded', load });

  if (config.measureMemory) {
    await emit({ type: 'memory', memory: await measureMemory(adapter) });
  }

  // Queries that failed in a way that will not change are not run again on this page. In breakdown mode, an error
  // of one variant (e.g. its rewrite) only excludes that variant; a timeout excludes the query.
  const excluded = new Map<string, Outcome>();
  for (const step of config.steps) {
    if (excluded.has(step.query) || (step.variant && excluded.has(`${step.query}|${step.variant}`))) {
      continue;
    }
    await emit({ type: 'start', step });
    const text = queries.get(step.query)!;
    const expectedEntry = reference?.queries[step.query];
    const expected = expectedEntry?.agree ? expectedEntry.count : null;
    const result: ExecResult = { ...step, outcome: 'error', ms: null, count: null, expected, checksum: null };
    try {
      let ms: number;
      let executed: Awaited<ReturnType<EngineAdapter['query']>>;
      if (step.variant) {
        const variant = await adapter.queryVariant!(step.variant, text);
        ms = variant.ms;
        executed = variant;
        result.terms = variant.terms;
      } else {
        const start = performance.now();
        executed = await adapter.query(text, config.timeoutMs);
        ms = performance.now() - start;
      }
      result.resultType = executed.resultType;
      if (ms > config.timeoutMs) {
        result.outcome = 'timeout';
      } else {
        result.ms = ms;
        result.count = executed.count;
        result.checksum = executed.checksum;
        if (!expectedEntry) {
          result.outcome = 'unchecked';
        } else if (!expectedEntry.agree) {
          result.outcome = 'disputed';
        } else {
          result.outcome = executed.count === expected ? 'ok' : 'wrong';
        }
      }
    } catch (error: unknown) {
      result.outcome = classifyError(error);
      result.error = String((error as Error)?.message ?? error).slice(0, 2000);
    }
    if (result.outcome === 'timeout' || result.outcome === 'error' || result.outcome === 'unsupported') {
      excluded.set(step.variant && result.outcome !== 'timeout' ? `${step.query}|${step.variant}` : step.query, result.outcome);
    }
    await emit({ type: 'exec', result });
    if (result.outcome === 'timeout') {
      // Work of an abandoned query may still be scheduled; the runner continues on a fresh page.
      await emit({ type: 'restart', reason: `timeout of ${step.query}` });
      return;
    }
    // Let pending macrotasks (e.g. Oxigraph term finalizers, timers) run between executions.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  await emit({ type: 'done' });
}
