// Messages between the in-page harness and the Playwright runner. All timings are taken in the page.

export type Phase = 'support' | 'cold' | 'warmup' | 'timed' | 'rewarm';

export type Outcome = 'ok' | 'wrong' | 'unsupported' | 'timeout' | 'error' | 'oom' | 'unchecked' | 'disputed';

export interface Step {
  phase: Phase;
  round: number;
  query: string;
}

export interface BenchConfig {
  dataset: string;
  engine: string;
  measureMemory: boolean;
  timeoutMs: number;
  steps: Step[];
}

export interface MemoryInfo {
  method: 'measureUserAgentSpecificMemory' | 'cdp+wasm' | 'none';
  bytes: number | null;
  wasmBytes: number | null;
  failure?: string;
  breakdown?: unknown;
  usedJSHeapSize?: number;
}

export interface LoadInfo {
  fetchMs: number;
  inflateMs: number;
  importMs: number;
  initMs: number;
  parseMs: number | null;
  ingestMs: number;
  loadMs: number;
  quads: number;
  ntBytes: number;
  gzBytes: number;
  details: Record<string, number>;
}

export interface ExecResult {
  phase: Phase;
  round: number;
  query: string;
  outcome: Outcome;
  ms: number | null;
  count: number | null;
  expected: number | null;
  checksum: number | null;
  resultType?: string;
  error?: string;
}

export type BenchEvent =
  | { type: 'build'; build: unknown; userAgent: string; crossOriginIsolated: boolean }
  | { type: 'loaded'; load: LoadInfo }
  | { type: 'memory'; memory: MemoryInfo }
  | { type: 'start'; step: Step }
  | { type: 'exec'; result: ExecResult }
  | { type: 'done' }
  | { type: 'restart'; reason: string }
  | { type: 'fatal'; error: string };

/** Errors that mean the engine does not support (part of) a query, rather than failing while running it. */
export const UNSUPPORTED_PATTERN =
  /unsupported|not supported|not implemented|none of the configured actors were able|no actors? (?:are |were )?able|parse error|syntax error|unexpected token|expecting/iu;
