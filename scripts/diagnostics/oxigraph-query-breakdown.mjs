// Diagnostic, not part of the pipeline. Run from the repository root after `npm run prepare`:
//   node scripts/diagnostics/oxigraph-query-breakdown.mjs
// Diagnostic only: splits Oxigraph's C3 time into store.query() and term access, in Chromium.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
const ROOT = process.cwd();
const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.gz': 'application/gzip', '.sparql': 'text/plain' };
const page = `<!doctype html><script type="module">
import init, { Store } from '/node_modules/oxigraph/web.js';
await init();
const gz = await (await fetch('/data/watdiv-10/dataset.nt.gz')).arrayBuffer();
const nt = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
const store = new Store(); store.load(nt, { format: 'application/n-triples' });
const out = {};
for (const q of ['C3-1', 'S1-2', 'F5-1']) {
  const text = await (await fetch('/data/watdiv-10/queries/' + q + '.sparql')).text();
  const r = { queryOnly: [], queryAndIterate: [], queryAndTouch: [], jsonString: [], jsonParse: [] };
  for (let i = 0; i < 4; i++) {
    let t = performance.now(); let res = store.query(text); r.queryOnly.push(performance.now() - t); res = null;
    t = performance.now(); res = store.query(text); let n = 0; for (const m of res) for (const v of m.values()) n++; r.queryAndIterate.push(performance.now() - t); res = null;
    t = performance.now(); res = store.query(text); let c = 0; for (const m of res) for (const v of m.values()) c += v.termType.length > 0 ? v.value.length : 0; r.queryAndTouch.push(performance.now() - t); res = null;
    t = performance.now(); const s = store.query(text, { results_format: 'application/sparql-results+json' }); r.jsonString.push(performance.now() - t);
    t = performance.now(); const j = JSON.parse(s); let c2 = 0; for (const b of j.results.bindings) for (const k in b) c2 += b[k].value.length; r.jsonParse.push(performance.now() - t);
    r.count = j.results.bindings.length; r.checksumObjects = c; r.checksumJson = c2;
    await new Promise(res => setTimeout(res, 50));
  }
  out[q] = r;
}
window.__diag = out;
</script>`;
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }); res.end(readFileSync(f));
}).listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const b = await chromium.launch({ channel: 'chromium' });
const pg = await b.newPage();
await pg.goto(`http://127.0.0.1:${server.address().port}/`);
await pg.waitForFunction(() => window.__diag, null, { timeout: 300000 });
const d = await pg.evaluate(() => window.__diag);
for (const [q, r] of Object.entries(d)) {
  console.log(q, 'count', r.count, 'checksums', r.checksumObjects, r.checksumJson);
  for (const k of ['queryOnly', 'queryAndIterate', 'queryAndTouch', 'jsonString', 'jsonParse']) console.log('  ', k.padEnd(16), r[k].map(x => x.toFixed(1)).join(' '));
}
await b.close(); server.close();
