#!/usr/bin/env node
// Instantiates BSBM explore queries by pointing the BSBM test driver at a stub endpoint that records them.
// Usage: node scripts/capture-bsbm-queries.mjs <generated-dir-with-td_data> <templates-dir> <out-queries-dir> <instances>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [ generatedDir, templatesDir, outDir, instancesArg ] = process.argv.slice(2);
const INSTANCES = Number(instancesArg ?? 5);
const SEED = '9834533'; // Same seed as @jbr-experiment/bsbm uses for its test driver runs.
const IMAGE = 'vcity/bsbm:v1.0';
const EXCLUDED = new Set([ 6, 7 ]);

const mix = readFileSync(join(templatesDir, 'querymix.txt'), 'utf8').trim().split(/\s+/u).map(Number);

const received = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    let query = url.searchParams.get('query');
    if (!query && chunks.length > 0) {
      const body = Buffer.concat(chunks).toString('utf8');
      query = req.headers['content-type']?.includes('form') ? new URLSearchParams(body).get('query') : body;
    }
    received.push(query);
    if ((req.headers.accept ?? '').includes('rdf+xml')) {
      res.writeHead(200, { 'content-type': 'application/rdf+xml' });
      res.end('<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>');
    } else {
      res.writeHead(200, { 'content-type': 'application/sparql-results+xml' });
      res.end('<?xml version="1.0"?><sparql xmlns="http://www.w3.org/2005/sparql-results#"><head></head><results></results></sparql>');
    }
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
// Enough mixes so that every query type gets INSTANCES instances.
const minPerMix = Math.min(...[ ...new Set(mix) ].filter(q => !EXCLUDED.has(q)).map(q => mix.filter(m => m === q).length));
const runs = Math.ceil(INSTANCES / minPerMix);

const driver = new Promise((resolve, reject) => {
  const p = spawn('docker', [
    'run', '--rm', '--network', 'host', '-v', `${generatedDir}:/data`, IMAGE,
    'testdriver', '-idir', '/data/td_data', '-seed', SEED, '-w', '0', '-runs', String(runs),
    '-o', 'capture.xml', `http://127.0.0.1:${port}/sparql`,
  ], { stdio: [ 'ignore', 'inherit', 'inherit' ] });
  p.on('exit', code => code === 0 ? resolve() : reject(new Error(`testdriver exited with ${code}`)));
});
await driver;
server.close();

if (received.length !== runs * mix.length) {
  throw new Error(`Expected ${runs * mix.length} queries, received ${received.length}`);
}

// Verify the positional assignment against the template text (parameters become wildcards).
const normalize = s => s.replaceAll(/\s+/gu, ' ').trim();
const templateRegex = {};
for (const q of new Set(mix)) {
  const tpl = normalize(readFileSync(join(templatesDir, `query${q}.txt`), 'utf8'));
  const pattern = tpl.split(/%[A-Za-z0-9_]+%/u).map(p => p.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.+?');
  templateRegex[q] = new RegExp(`^${pattern}$`, 'u');
}

mkdirSync(outDir, { recursive: true });
const counts = {};
const manifest = [];
received.forEach((query, i) => {
  const type = mix[i % mix.length];
  if (!templateRegex[type].test(normalize(query))) {
    throw new Error(`Query ${i} does not match template ${type}:\n${query}`);
  }
  if (EXCLUDED.has(type)) {
    return;
  }
  counts[type] = (counts[type] ?? 0) + 1;
  if (counts[type] > INSTANCES) {
    return;
  }
  const id = `Q${type}-${counts[type]}`;
  writeFileSync(join(outDir, `${id}.sparql`), `${query.replaceAll('\r\n', '\n').trim()}\n`);
  manifest.push({ id, template: `Q${type}`, mixPosition: i });
});
console.log(`Captured ${received.length} queries over ${runs} mixes (seed ${SEED}); wrote ${manifest.length} instances to ${outDir}`);
