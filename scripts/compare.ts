// Compares the timing runs of two sets of results directories (A = before, B = after) per dataset, browser and engine.
// Each side may list several directories, comma-separated (for example two baseline passes); every timing raw file is
// one repetition. Over the instances that are ok in every repetition of both sides, it reports the median and range of
// the per-repetition totals of warm means, and the geometric mean of the per-instance ratios B ÷ A, where an
// instance's time is the median over repetitions of its warm mean (so one slow page does not shift the result).
// Below 1 (negative %) means B is faster. Templates that changed most and outcome changes are listed below the table.
// --from-round N uses only timed rounds N and later, to check whether the result depends on JIT warm-up still going on
// in the first timed rounds.
// Usage: npm run compare -- results/<A>[,results/<A2>] results/<B> [--engines comunica] [--browsers chromium,node26]
//   [--from-round 1] [--out file.md]
//   [--csv file.csv]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BROWSERS, DATASETS, ENGINES, instanceStats, median, round, writeCsv } from './aggregate';
import { readTimingRaws } from './plot-common';

const geomean = (xs: number[]) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
const ms = (x: number) => x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x.toFixed(x < 10 ? 2 : 0)} ms`;
const pct = (ratio: number) => `${ratio < 1 ? '−' : '+'}${Math.abs(100 * (ratio - 1)).toFixed(1)} %`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    engines: { type: 'string' },
    // Environments to compare: browsers, or Node runs of npm run bench:node (node22, node24, node26, …).
    browsers: { type: 'string' },
    out: { type: 'string' },
    csv: { type: 'string' },
    top: { type: 'string', default: '3' },
    'from-round': { type: 'string', default: '1' },
  },
});
if (positionals.length !== 2) {
  throw new Error('Usage: npm run compare -- results/<A>[,results/<A2>] results/<B> [--engines comunica] [--out file.md] [--csv file.csv]');
}
const [ dirsA, dirsB ] = positionals.map(p => p.split(',').map(d => resolve(d)));
const engines = values.engines?.split(',') ?? ENGINES;
const browsers = values.browsers?.split(',') ?? BROWSERS;
const top = Number(values.top);
const fromRound = Number(values['from-round']);

/** Per repetition (raw file): the warm mean and outcome of every instance. */
function repetitions(dirs: string[], dataset: string, browser: string, engine: string) {
  return dirs.flatMap(dir => readTimingRaws(dir, dataset, browser, engine))
    .map(raw => ({ ...raw, executions: raw.executions.filter((e: any) => e.phase !== 'timed' || e.round >= fromRound) }))
    .map(raw => new Map(instanceStats([ raw ], dataset, 'timing').map(s => [ s.query, s ])));
}

const L: string[] = [
  `A: ${positionals[0].split(',').map(d => `\`${d}\``).join(' + ')}; B: ${positionals[1].split(',').map(d => `\`${d}\``).join(' + ')}.`,
  'Totals: median (min–max) over repetitions of the sum of warm means over the common instances. Ratio = B ÷ A; ' +
    `negative % means B is faster.${fromRound > 1 ? ` Warm means over timed rounds ${fromRound} and later only.` : ''}`,
  '',
  '| Dataset | Browser | Engine | Instances | Reps A | Reps B | Total A | Total B | Median total B ÷ A | Geomean of ratios | Faster by >10 % | Slower by >10 % |',
  '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
];
const csv: (string | number)[][] = [];
const details: string[] = [];
for (const dataset of DATASETS) {
  for (const browser of browsers) {
    for (const engine of engines) {
      const a = repetitions(dirsA, dataset, browser, engine);
      const b = repetitions(dirsB, dataset, browser, engine);
      if (a.length === 0 || b.length === 0) {
        continue;
      }
      const queries = [ ...a[0].keys() ];
      const okEverywhere = (q: string) => [ ...a, ...b ].every(rep => rep.get(q)?.outcome === 'ok');
      const common = queries.filter(okEverywhere);
      const outcomes = (reps: typeof a, q: string) => [ ...new Set(reps.map(rep => rep.get(q)?.outcome ?? 'missing')) ].join('/');
      const changed = queries.filter(q => !okEverywhere(q) && outcomes(a, q) !== outcomes(b, q))
        .map(q => `${q} ${outcomes(a, q)} → ${outcomes(b, q)}`);
      if (common.length === 0) {
        continue;
      }
      const totals = (reps: typeof a) => reps.map(rep => common.reduce((x, q) => x + rep.get(q)!.mean!, 0));
      const range = (xs: number[]) => `${ms(median(xs)!)} (${ms(Math.min(...xs))}–${ms(Math.max(...xs))})`;
      const perInstance = (reps: typeof a, q: string) => median(reps.map(rep => rep.get(q)!.mean!))!;
      const ratios = common.map(q => perInstance(b, q) / perInstance(a, q));
      const totalRatio = median(totals(b))! / median(totals(a))!;
      const g = geomean(ratios);
      L.push(`| ${dataset} | ${browser} | ${engine} | ${common.length} | ${a.length} | ${b.length} | ${range(totals(a))} | ` +
        `${range(totals(b))} | ${pct(totalRatio)} | ${pct(g)} | ${ratios.filter(r => r < 1 / 1.1).length} | ${ratios.filter(r => r > 1.1).length} |`);
      csv.push([ dataset, browser, engine, common.length, a.length, b.length, round(median(totals(a)), 3),
        round(median(totals(b)), 3), round(totalRatio, 4), round(g, 4) ]);
      // Templates with the largest change, by the geometric mean over their instances.
      const template = (q: string) => q.replace(/-\d+$/u, '');
      const templates = [ ...new Set(common.map(template)) ].map((t) => {
        const of = common.filter(q => template(q) === t);
        return { t, g: geomean(of.map(q => perInstance(b, q) / perInstance(a, q))),
          a: of.reduce((x, q) => x + perInstance(a, q), 0) / of.length, b: of.reduce((x, q) => x + perInstance(b, q), 0) / of.length };
      }).sort((x, y) => x.g - y.g);
      const fmt = (x: typeof templates[number]) => `${x.t} ${pct(x.g)} (${ms(x.a)} → ${ms(x.b)})`;
      details.push(`- ${dataset} / ${browser} / ${engine}: most faster ${templates.slice(0, top).map(fmt).join(', ')}; ` +
        `most slower ${templates.slice(-top).reverse().map(fmt).join(', ')}` +
        `${changed.length > 0 ? `; outcome changes: ${changed.join(', ')}` : ''}`);
    }
  }
}
L.push('', 'Per template (geometric mean over its instances, mean of the per-instance medians A → B):', '', ...details, '');
const text = L.join('\n');
console.log(text);
if (values.out) {
  writeFileSync(values.out, `${text}\n`);
}
if (values.csv) {
  writeCsv(values.csv, [ 'dataset', 'browser', 'engine', 'instances', 'reps_a', 'reps_b', 'median_total_a_ms',
    'median_total_b_ms', 'median_total_ratio', 'geomean_ratio' ], csv);
}
