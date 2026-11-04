// Compares the timing runs of two results directories (A = before, B = after), per dataset, browser and engine,
// over the instances that are ok in both: totals of the warm means, the geometric mean of the per-instance ratios
// B ÷ A (below 1 = B faster), and the templates that changed most. Outcome changes are listed separately.
// Usage: npm run compare -- results/<A> results/<B> [--engines comunica] [--out compare.md] [--csv compare.csv]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BROWSERS, DATASETS, ENGINES, instanceStats, round, writeCsv } from './aggregate';
import { readTimingRaws } from './plot-common';

const geomean = (xs: number[]) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
const ms = (x: number) => x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x.toFixed(x < 10 ? 2 : 0)} ms`;
const pct = (ratio: number) => `${ratio < 1 ? '−' : '+'}${Math.abs(100 * (ratio - 1)).toFixed(1)} %`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { engines: { type: 'string' }, out: { type: 'string' }, csv: { type: 'string' }, top: { type: 'string', default: '3' } },
});
if (positionals.length !== 2) {
  throw new Error('Usage: npm run compare -- results/<A> results/<B> [--engines comunica] [--out file.md] [--csv file.csv]');
}
const [ dirA, dirB ] = positionals.map(p => resolve(p));
const engines = values.engines?.split(',') ?? ENGINES;
const top = Number(values.top);

const L: string[] = [ `A: \`${positionals[0]}\`, B: \`${positionals[1]}\`. Ratio = B ÷ A; below 1 (negative %) means B is faster.`, '' ];
L.push('| Dataset | Browser | Engine | Instances | Total A | Total B | Total B ÷ A | Geomean of ratios | Faster by >10 % | Slower by >10 % |');
L.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
const csv: (string | number)[][] = [];
const details: string[] = [];
for (const dataset of DATASETS) {
  for (const browser of BROWSERS) {
    for (const engine of engines) {
      const rawsA = readTimingRaws(dirA, dataset, browser, engine);
      const rawsB = readTimingRaws(dirB, dataset, browser, engine);
      if (rawsA.length === 0 || rawsB.length === 0) {
        continue;
      }
      const a = new Map(instanceStats(rawsA, dataset, 'timing').map(s => [ s.query, s ]));
      const b = instanceStats(rawsB, dataset, 'timing');
      const changed = b.filter(s => a.has(s.query) && a.get(s.query)!.outcome !== s.outcome)
        .map(s => `${s.query} ${a.get(s.query)!.outcome} → ${s.outcome}`);
      const common = b.filter(s => s.outcome === 'ok' && a.get(s.query)?.outcome === 'ok')
        .map(s => ({ query: s.query, template: s.template, a: a.get(s.query)!.mean!, b: s.mean! }));
      if (common.length === 0) {
        continue;
      }
      const ratios = common.map(c => c.b / c.a);
      const totalA = common.reduce((x, c) => x + c.a, 0);
      const totalB = common.reduce((x, c) => x + c.b, 0);
      const g = geomean(ratios);
      L.push(`| ${dataset} | ${browser} | ${engine} | ${common.length} | ${ms(totalA)} | ${ms(totalB)} | ${pct(totalB / totalA)} | ` +
        `${pct(g)} | ${ratios.filter(r => r < 1 / 1.1).length} | ${ratios.filter(r => r > 1.1).length} |`);
      csv.push([ dataset, browser, engine, common.length, round(totalA, 3), round(totalB, 3), round(totalB / totalA, 4), round(g, 4) ]);
      // Templates with the largest change, by the geometric mean over their instances.
      const templates = [ ...new Set(common.map(c => c.template)) ].map((t) => {
        const of = common.filter(c => c.template === t);
        return { t, g: geomean(of.map(c => c.b / c.a)), a: of.reduce((x, c) => x + c.a, 0) / of.length, b: of.reduce((x, c) => x + c.b, 0) / of.length };
      }).sort((x, y) => x.g - y.g);
      const fmt = (x: typeof templates[number]) => `${x.t} ${pct(x.g)} (${ms(x.a)} → ${ms(x.b)})`;
      details.push(`- ${dataset} / ${browser} / ${engine}: most faster ${templates.slice(0, top).map(fmt).join(', ')}; ` +
        `most slower ${templates.slice(-top).reverse().map(fmt).join(', ')}` +
        `${changed.length > 0 ? `; outcome changes: ${changed.join(', ')}` : ''}`);
    }
  }
}
L.push('', 'Per template (geometric mean over its instances, mean times A → B):', '', ...details, '');
const text = L.join('\n');
console.log(text);
if (values.out) {
  writeFileSync(values.out, `${text}\n`);
}
if (values.csv) {
  writeCsv(values.csv, [ 'dataset', 'browser', 'engine', 'instances', 'total_a_ms', 'total_b_ms', 'total_ratio', 'geomean_ratio' ], csv);
}
