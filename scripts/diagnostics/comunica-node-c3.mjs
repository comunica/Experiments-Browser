// Diagnostic, not part of the pipeline. Run from the repository root after `npm run prepare`:
//   node --max-old-space-size=8192 scripts/diagnostics/comunica-node-c3.mjs
// Diagnostic only: C3-1 in plain Node (no tsx), ordered store.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { QueryEngine } = require('@comunica/query-sparql-rdfjs-lite');
const { compareTerms } = require('@comunica/utils-iterator');
const { Parser } = require('n3');
const { RdfStore } = require('rdf-stores');
const store = RdfStore.createOrdered({ termComparator: compareTerms, nodes: true });
store.addQuads(new Parser({ format: 'N-Triples' }).parse(gunzipSync(readFileSync('data/watdiv-10/dataset.nt.gz')).toString()));
const engine = new QueryEngine();
const text = readFileSync('data/watdiv-10/queries/C3-1.sparql', 'utf8');
for (let i = 0; i < 4; i++) {
  const t = performance.now();
  const s = await engine.queryBindings(text, { sources: [ store ] });
  let n = 0; await new Promise((res, rej) => s.on('data', () => n++).on('end', res).on('error', rej));
  console.log(n, (performance.now() - t).toFixed(1), 'ms', process.sourceMapsEnabled ? 'sourcemaps on' : 'sourcemaps off');
}
