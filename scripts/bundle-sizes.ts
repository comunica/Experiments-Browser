// Computes per-page bundle sizes (JS + WASM, raw and gzipped) from the Vite manifest.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

interface ManifestEntry {
  file: string;
  imports?: string[];
  dynamicImports?: string[];
  assets?: string[];
}

const dist = resolve(import.meta.dirname, '..', 'dist');
const manifest: Record<string, ManifestEntry> = JSON.parse(readFileSync(resolve(dist, '.vite/manifest.json'), 'utf8'));

// Benchmark instrumentation that only the breakdown mode loads; not part of what an application would ship.
const INSTRUMENTATION = (key: string) => key.includes('oxigraph-breakdown');

// Every Comunica module in the pages must come from the monorepo checkout built by `npm run prepare` (packages/ or
// engines/), never from a published @comunica package that a dependency installed from npm.
const modules: string[] = Object.values<{ modules: Record<string, number> }>(
  JSON.parse(readFileSync(resolve(dist, 'bundle-modules.json'), 'utf8')),
).flatMap(chunk => Object.keys(chunk.modules));
const foreign = modules.filter(id => /(^|\/)node_modules\/@comunica\//u.test(id));
if (foreign.length > 0) {
  throw new Error(`Comunica modules from outside the checkout in the bundle:\n  ${foreign.slice(0, 20).join('\n  ')}`);
}
const fromCheckout = modules.filter(id => /^\.cache\/comunica\/(packages|engines)\//u.test(id));
console.log(`${fromCheckout.length} Comunica modules, all from the checkout at ${
  JSON.parse(readFileSync(resolve(dist, '..', '.cache', 'comunica-build.json'), 'utf8')).commit}`);

function files(key: string, seen = new Set<string>()): Set<string> {
  if (seen.has(key) || INSTRUMENTATION(key)) {
    return seen;
  }
  seen.add(key);
  const entry = manifest[key];
  for (const next of [ ...entry.imports ?? [], ...entry.dynamicImports ?? [] ]) {
    files(next, seen);
  }
  return seen;
}

function sizes(keys: Iterable<string>) {
  const result = { jsRaw: 0, jsGzip: 0, wasmRaw: 0, wasmGzip: 0, files: [] as string[] };
  const add = (file: string) => {
    const data = readFileSync(resolve(dist, file));
    const gz = gzipSync(data, { level: 9 }).length;
    if (file.endsWith('.wasm')) {
      result.wasmRaw += data.length;
      result.wasmGzip += gz;
    } else {
      result.jsRaw += data.length;
      result.jsGzip += gz;
    }
    result.files.push(file);
  };
  for (const key of keys) {
    add(manifest[key].file);
    for (const asset of manifest[key].assets ?? []) {
      add(asset);
    }
  }
  return { ...result, totalRaw: result.jsRaw + result.wasmRaw, totalGzip: result.jsGzip + result.wasmGzip };
}

const rows = [
  { page: 'comunica', keys: files('comunica.html') },
  { page: 'oxigraph', keys: files('oxigraph.html') },
].map(({ page, keys }) => {
  const adapter = [ ...keys ].find(key => key.startsWith('../adapters/'))!;
  return { page, ...sizes(keys), engineOnly: sizes([ adapter ]) };
});

writeFileSync(resolve(dist, 'bundle-sizes.json'), `${JSON.stringify(rows, null, 2)}\n`);
const kb = (bytes: number) => (bytes / 1000).toFixed(1).padStart(9);
console.log('\nBundle sizes per page (kB = 1000 bytes; gzip level 9; whole page = harness + adapter + engine)');
console.log(`${'page'.padEnd(22)} ${'JS raw'.padStart(9)} ${'JS gz'.padStart(9)} ${'WASM raw'.padStart(9)} ${'WASM gz'.padStart(9)} ${'total raw'.padStart(9)} ${'total gz'.padStart(9)}`);
for (const row of rows) {
  console.log(`${row.page.padEnd(22)} ${kb(row.jsRaw)} ${kb(row.jsGzip)} ${kb(row.wasmRaw)} ${kb(row.wasmGzip)} ${kb(row.totalRaw)} ${kb(row.totalGzip)}`);
}
