// Reads a gzipped N-Triples file in Node as line-aligned string chunks, as the browser harness does:
// large datasets exceed the maximum string length.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { CHUNK_CHARS } from './adapters/types';

export function readChunks(file: string): string[] {
  const nt = gunzipSync(readFileSync(file));
  const chunks: string[] = [];
  for (let start = 0; start < nt.length;) {
    let end = Math.min(start + CHUNK_CHARS, nt.length);
    end = end < nt.length ? nt.indexOf(0x0A, end) + 1 || nt.length : end;
    chunks.push(nt.toString('utf8', start, end));
    start = end;
  }
  return chunks;
}
