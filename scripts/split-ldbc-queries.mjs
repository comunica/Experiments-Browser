#!/usr/bin/env node
// Splits the LDBC SNB query files written by @jbr-experiment/ldbc-snb (instances joined by blank lines) into one
// file per instance. Queries themselves contain blank lines, so an instance starts at a line that opens a query
// (a comment or PREFIX) right after a blank line that follows the end of the previous query.
// Usage: node scripts/split-ldbc-queries.mjs <generated-queries-dir> <out-dir> <instances>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [ src, dst, n ] = process.argv.slice(2);
mkdirSync(dst, { recursive: true });
for (const file of readdirSync(src).filter(f => f.endsWith('.sparql')).sort()) {
  const match = /^interactive-(short|complex)-(\d+)\.sparql$/u.exec(file);
  if (!match) {
    throw new Error(`Unexpected query file ${file}`);
  }
  const id = `${match[1] === 'short' ? 'IS' : 'IC'}${match[2]}`;
  const text = readFileSync(join(src, file), 'utf8');
  // Every instance begins with the template's first line, which never occurs inside a query.
  const firstLine = text.split('\n')[0];
  const starts = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line === firstLine && (i === 0 || lines[i - 1].trim() === '')) {
      starts.push(i);
    }
  });
  if (starts.length !== Number(n)) {
    throw new Error(`${file}: expected ${n} instances, found ${starts.length}`);
  }
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    writeFileSync(join(dst, `${id}-${k + 1}.sparql`), `${lines.slice(start, end).join('\n').trim()}\n`);
  });
}
