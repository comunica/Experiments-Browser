# Comunica and Oxigraph in the browser

A reproducible comparison of two SPARQL engines running inside a browser tab over local RDF data:

- **Comunica**: `@comunica/query-sparql-rdfjs-lite`, built from a
  [comunica/comunica](https://github.com/comunica/comunica) master checkout, querying an ordered
  [`rdf-stores`](https://github.com/rubensworks/rdf-stores.js) store filled by the [N3.js](https://github.com/rdfjs/N3.js) parser.
- **Oxigraph**: the [`oxigraph`](https://www.npmjs.com/package/oxigraph) npm package (0.5.x, `web.js` WASM build) with its own
  in-memory store.

Both run the same WatDiv, BSBM and LDBC SNB Interactive queries over the same data in Chromium, Firefox and WebKit
(headless, via Playwright).
Every query result is fully consumed and counted, counts are checked against reference counts, and failures are
published next to the timings. Federation, HTTP sources, Solid, updates and Node.js timings are out of scope.

## Results at a glance

From [`results/2026-11-01-cloud-4vcpu/`](results/2026-11-01-cloud-4vcpu/README.md) (4-vCPU cloud VM; Chromium 153,
Firefox 155, WebKit 26.6; Comunica master `e06d02e`, Oxigraph 0.5.13; 3 repetitions, LDBC SNB 1). Read the
[notes](results/2026-11-01-cloud-4vcpu/README.md#notes) before quoting any of this.

- **WatDiv and BSBM**: both engines return the correct count for all 300 query instances in all three browsers. Per
  query, Oxigraph is faster on 17 to 20 of the 20 WatDiv templates and 9 to 10 of the 10 BSBM templates; Comunica is
  2.2 to 15 times slower in geometric mean (least in Chromium, most in Firefox). WatDiv C3 is the exception (Oxigraph
  1.9 to 2.4 s at 1.1M triples, Comunica 0.14 to 0.30 s) and, at 95 to 99 % of Oxigraph's WatDiv total, makes
  Comunica's WatDiv totals lower; without C3, and on BSBM, Oxigraph's are.
- **LDBC SNB Interactive** (4.0M triples) is much more even: in Chromium, Comunica is faster on 10 of the 21 templates
  and 2.5 times faster in geometric mean over the instances both answer; in Firefox, Oxigraph leads 12 to 9 and is
  1.26 times faster. Each engine times out on queries the other answers (Comunica on IC9 and on IS7 for messages
  without replies, Oxigraph on IC4). In WebKit, Comunica's LDBC run could not be completed: every page grew to 5 to
  7.6 GB and stopped responding or crashed after a few queries.
- Moving Oxigraph's results from WebAssembly into JavaScript costs 2.7 µs per result term in Chromium (2.6 µs per
  result of 1 variable, 8.2 µs of 3), measured on calibration scans. That is 3 to 10 % of Oxigraph's time on WatDiv and
  BSBM and negligible on LDBC SNB, so it does not explain the comparison; it dominates only for many results from cheap
  queries (Chromium only so far).
- These results used one warm-up round. The warm-up experiment
  ([`results/2026-11-05-warmup-cloud-4vcpu/`](results/2026-11-05-warmup-cloud-4vcpu/README.md), Comunica master
  `55a70ad`) shows that this left Comunica's warm times 9 to 13 % above their plateau (Oxigraph's 1 to 9 %); after 10
  rounds both are within about ±3 %, which is the default now. Warmed up, Comunica is 19 to 30 % faster in Chromium
  than in Node 22 per typical query, as fast in WebKit, and 2.3 to 3.5 times slower in Firefox.
- Loading takes the same order of time in both engines, except Comunica on LDBC SNB in Firefox (200 s against 18 s).
  Memory after load is lower for Comunica (681 vs 1,557 MB on LDBC SNB in Chromium); the Oxigraph page transfers 5.4
  times more (1,542 vs 285 kB gzipped).

## Reproduce

```bash
git clone https://github.com/comunica/Experiments-Browser && cd Experiments-Browser
npm install            # also runs `prepare`
npm run prepare        # clone + build Comunica, link it, install Playwright browsers (idempotent)
npm run build          # Vite build of both pages, prints bundle sizes, checks Comunica comes from the checkout
npm run reference      # reference counts in Node, both engines -> data/*/reference.json
npm run bench          # support pass, timing runs, Oxigraph breakdown -> results/<date>-<machine>/raw/*.json
npm run aggregate      # raw JSON -> CSVs, totals, support matrix, results README tables
npm run plot           # CSV -> SVG (includes the plot:split charts)
npm run plot:split     # only Oxigraph's time split into evaluation and WASM -> JS transfer
npm run compare -- results/<A>[,results/<A2>] results/<B>   # before/after comparison of two runs
npm run bench -- --mode warmup        # warm-up experiment: cold run + 30 recorded rounds per configuration
npm run bench:node -- --mode warmup   # the same for Comunica in Node, as a reference on V8 outside a browser
npm run plot:warmup -- results/<dir>  # warm-up curves, and bias and noise per number of warm-up rounds
```

- Linux needs the browsers' system libraries once: `npx playwright install-deps chromium firefox webkit`.
- `npm run prepare` builds Comunica at the commit pinned in `package.json` (`config.comunicaCommit`, currently master
  `6b5eb94`; the 2026-11-01 results used `e06d02e`) from the monorepo itself, with its own lockfile, so every actor,
  mediator and bus comes from that commit; `npm run build` fails if the bundle contains any `@comunica` module from npm,
  and `npm run bench` warns when the build is not Comunica's latest master (recorded as `comunicaMaster` in `meta.json`). Set
  `COMUNICA_REF=master` (or any branch, tag or commit) to build another one; the commit that was built is written to
  `.cache/comunica-build.json`, embedded in both pages, and recorded in every raw result and in `meta.json`.
- `npm run bench` is resumable: it skips configurations whose raw file exists (`--force` reruns them). The default
  output directory is named after the current UTC date, so pass `--out results/<dir>` to resume a run on a later day.
  Options:
  `--browsers`, `--engines`, `--datasets`, `--mode support|timing|breakdown|warmup|all`, `--out`, `--machine` (or
  `BENCH_MACHINE`), `--timeout` (ms, default 60000), `--rounds` (5), `--warmup` (10), `--warmup-overrides` (default
  `ldbc-snb-0.1=1`), `--curve-rounds` (30, for `--mode warmup`), `--repeat` (3),
  `--repeat-overrides` (default `ldbc-snb-0.1=1`: LDBC SNB runs once, as one repetition already takes hours), and
  `--skip 'browser/engine/dataset=reason;…'` for configurations that cannot run on a machine (recorded in `meta.json`).
- `--queries 'dataset=Q1,Q2'` runs a subset of a dataset's queries (raw files get a `-subset` suffix, and a complete run
  of the dataset takes precedence in the aggregation).
- To measure a Comunica change, build each commit once (`COMUNICA_REF=<commit> npm run prepare && npm run build`), keep
  a copy of `dist/` per commit, and run the passes back to back by swapping `dist/` and `.cache/comunica-build.json`,
  so no build runs during a timed pass; every raw file records the commit embedded in its page. `npm run compare`
  reports per dataset, browser and engine the median over repetitions of the totals and the geometric mean of the
  per-instance ratios. Run the baseline twice (passes before and after the change) and keep Oxigraph in the runs: the
  differences between the two baseline passes, and Oxigraph's, show the noise between passes. Example:
  [`results/2026-11-04-comunica-483dc3c-vs-e06d02e.md`](results/2026-11-04-comunica-483dc3c-vs-e06d02e.md).
- `npm install <package>` removes the linked Comunica packages from `node_modules`; run `npm run prepare` again (the
  build refuses to run without them).
- Regenerating the datasets is not part of the pipeline (they are committed); see [`data/README.md`](data/README.md).

## What is compared

| | Comunica | Oxigraph |
|---|---|---|
| Package | `@comunica/query-sparql-rdfjs-lite`, from a comunica master checkout (`yarn install`, `yarn build`, linked like `npm link`) | `oxigraph` 0.5.13, `web.js` |
| Store | `RdfStore.createOrdered({ termComparator: compareTerms, nodes: true })`: GSOP, GPSO and GOPS indexes in term order, as comunica/comunica#1839 uses for files | Oxigraph's in-memory store |
| Loading | `new N3.Parser({ format: 'N-Triples', blankNodePrefix: '' }).parse(chunk)` for every chunk, then one `store.addQuads(quads)` batch with all quads (as in #1839) | `store.load(chunks, { format: 'application/n-triples' })` |
| Querying | `engine.query(sparql, { sources: [store] })`, results consumed from the stream | `store.query(sparql)` (synchronous; returns arrays) |
| Adapter | [`src/adapters/comunica.ts`](src/adapters/comunica.ts) | [`src/adapters/oxigraph.ts`](src/adapters/oxigraph.ts) |

`N3.Store` is not used anywhere. Both engines get the same query text; there are no engine-specific rewrites.

## How it is measured

**Pages.** One [Vite config](vite.config.ts), two entries ([`comunica.html`](src/pages/comunica.html),
[`oxigraph.html`](src/pages/oxigraph.html)), built in one build, so minification and transforms are identical. The pages
differ only in the adapter they import. Both import the same [harness](src/harness.ts). Packages present at the same
version in both the project and the Comunica checkout are deduplicated in the bundle, as an application install would.

**Timing.** All timings are taken inside the page with `performance.now()`. The
[runner](src/runner.ts) (Playwright) only passes configuration in and receives the numbers; it never times anything
across the browser boundary. Its only clock is a watchdog that kills a page that stops responding.

**Per run** (one browser, one engine, one dataset), in a fresh browser process and context. Every run is
repeated (`--repeat`, default 3; LDBC SNB once, see `--repeat-overrides`); repetitions are the outer loop, so a slow moment of the machine hits one repetition of
many configurations rather than all repetitions of one:

1. **Fetch + inflate**: fetch `dataset.nt.gz` and inflate it with `DecompressionStream` into line-aligned strings of
   about 16M characters (LDBC SNB's 706 MB does not fit in one V8 string). Timed, but not charged to the engine.
   Both engines get the same chunks: Oxigraph reads them as one document; for Comunica, N3.js parses each chunk with
   `blankNodePrefix: ''` so blank node labels keep joining across chunks, and all quads then go into the store in one
   batch.
2. **Engine init**: dynamically import the adapter chunk (Comunica's JS; Oxigraph's JS glue and WASM) and construct
   the engine (`new QueryEngine()`; Oxigraph's `init()`).
3. **Load** = parse + ingest. Comunica: parse is N3.js parsing plus building the store, and ingest is 0 since Comunica
   queries that RDF/JS store in place (the two sub-steps are in the raw files). Oxigraph parses and ingests inside one
   `Store.load()` call; that time is reported as ingest and parse is empty.
4. **Memory after load** (Chromium only): `gc()`, then `performance.measureUserAgentSpecificMemory()` (pages are served
   with COOP/COEP, so they are cross-origin isolated). If the API fails, the runner falls back to V8's heap size over CDP
   plus the size of the engine's `WebAssembly.Memory`, and the raw file says so. This is the footprint after loading,
   not the peak during loading, except that WASM memory never shrinks, so for Oxigraph it includes its peak.
5. **Cold pass**: every query once, in a fixed order, on this freshly loaded page.
6. **Warmup**: ten rounds over all queries, not used (one for LDBC SNB, whose queries take seconds and show no trend
   after one round). The warm-up experiment below chose the number.
7. **Timed rounds**: five rounds over all queries (round-robin).

Over the repetitions: warm time = mean, min and max of all timed executions of an instance (3 × 5 = 15, or 5 for
LDBC SNB); cold time =
mean of its cold executions (one per repetition); init, load and memory = median over repetitions, with the range.

**A query execution** ends when the last result has been materialised: every solution (or quad) is counted and every
bound term's `termType` and `value` is read once (for Oxigraph that copies the term out of WASM memory; Comunica's
terms are JS objects already). Each execution also records a checksum (sum of all value lengths).

**Outcomes.** Every execution is classified:

| Outcome | Meaning |
|---|---|
| `ok` | count equals the reference count |
| `wrong` | count differs from the reference count |
| `unsupported` | the engine rejected the query (parse error, unsupported feature, no actor able to handle it) |
| `timeout` | took longer than 60 s. Comunica's stream is destroyed in-page; Oxigraph's synchronous call cannot be interrupted, so the runner kills the page after 60 + 30 s |
| `error` | any other error |
| `oom` | the page crashed |

A query that times out, errors or is unsupported is not executed again in that run. After a timeout or crash the
runner continues on a fresh page (dataset reloaded; if the run was in its warm phases, one unrecorded re-warm round
first). An instance's outcome is its first non-`ok` outcome over all its executions. Timings are aggregated over `ok`
executions only.

**Reference counts** come from Node, where [`src/reference.ts`](src/reference.ts) runs every query against both engines
with the same store setup and the same chunked input. Oxigraph runs in a worker thread, so that a query exceeding the
reference timeout (300 s, as in Experiments-Centralized's LDBC SNB experiment) can be stopped; Comunica's are stopped
in-process. Where the engines disagree, there is no reference count and the script fails instead of picking one;
where only one engine answers, its count is used and `reference.json` says which engine confirmed it.

**Oxigraph breakdown** (`--mode breakdown`, part of `--mode all`): Oxigraph runs in WebAssembly, so its results have
to cross into JavaScript, and the timing runs include that. To report how much of its time that is, every query
instance also runs as four variants on one page per browser and dataset, back to back, in an order that rotates per
round (the warm-up rounds of the timing runs, then 3 timed rounds, `--breakdown-rounds`):

| Variant | What runs | Measures |
|---|---|---|
| `count` | `SELECT (COUNT(*) AS ?n) WHERE { { query } }` | evaluation, with only one number crossing into JavaScript (SELECT queries only). A lower bound: the wrapper may let Oxigraph skip work, such as an ORDER BY without LIMIT |
| `objects` | `store.query(q)` | evaluation plus building the JS result: a `Map` per solution and a wrapper object per term |
| `full` | `store.query(q)` and reading every term's value | what the timing runs measure; reading a value copies the string out of WASM memory |
| `json` | `store.query(q, { results_format: 'application/sparql-results+json' })`, `JSON.parse`, every value read | the alternative of one serialized string crossing the boundary (N-Triples, lines counted, for CONSTRUCT and DESCRIBE) |

(full − count) ÷ full is reported as an upper bound on the share of time spent moving results into JavaScript, split
into building the objects (objects − count) and reading the values (full − objects). The overhead is also normalized by
the number of results: per instance, and averaged per dataset and over all benchmark datasets, as total overhead ÷
total results, as the median over instances, and as a least-squares fit of overhead against results (slope: cost per
result; intercept: fixed cost per query). For complex queries with few results, wrapping them in COUNT can change
Oxigraph's plan, so their overhead estimates are dominated by plan differences and timer noise. The breakdown therefore
also runs a calibration set ([`data/calibration`](data/calibration)): scans `SELECT ?s … LIMIT N` and
`SELECT ?s ?p ?o … LIMIT N` with N up to 100,000, whose plan the wrapper cannot change, which measure the cost per result
of 1 and 3 variables directly. Each variant's count is checked against the reference. Queries that timed out for Oxigraph in that browser's
timing runs are not repeated. The variant code is in [`src/adapters/oxigraph-breakdown.ts`](src/adapters/oxigraph-breakdown.ts),
loaded only in this mode and left out of the bundle sizes.

`npm run plot:split [-- results/<dir>] [--overhead calibrated|measured] [--browsers chromium,…] [--top 5]`
([`scripts/plot-split.ts`](scripts/plot-split.ts), also run by `npm run plot`) draws Oxigraph's full time as stacked
bars of evaluation and WASM → JS transfer: `plot_oxigraph_split.svg` (one bar per dataset and browser, as shares, since
the totals differ by orders of magnitude) and `<dataset>/plot_oxigraph_split_<browser>.svg` (one bar per template, in
ms on a linear scale and as shares), with the numbers in `oxigraph_split.csv` and `<dataset>/oxigraph_split_<browser>.csv`.
By default (`calibrated`) the transfer of a query is its number of result terms times the cost per term fitted on the
calibration scans in the same browser, and evaluation is the rest of its full time. `measured` uses full − count per
query instead, which is what the calibration replaces: for single queries that difference is often smaller than the
run-to-run variation, or negative. Both use the instances that ran all four variants (SELECT queries).
With `calibrated`, it also writes `plot_oxigraph_split_top_<browser>.svg` and its CSV: the `--top` templates with the
largest estimated transfer in ms and the `--top` with the largest share of Oxigraph's time, each with Comunica's time
and Oxigraph's split into evaluation and transfer, from the timing runs' warm means over the instances both engines
answered.

**Warm-up experiment** (`--mode warmup`): every configuration runs each query once cold and then `--curve-rounds`
(30) recorded rounds without warmup, in a fresh browser per repetition; `npm run bench:node -- --mode warmup` does the
same for Comunica in Node, with the same build, store, loader and query function. `npm run plot:warmup` draws how a
typical query's time converges over the rounds, and, for w warm-up rounds followed by 5 timed rounds, the bias of the
warm mean against the run's plateau (its last 10 rounds) and the noise of an A/A comparison between two runs of the
same build. That noise comes from runs that are slow as a whole or for a stretch of rounds, which more warm-up cannot
remove; comparisons of builds need several repetitions per side.

**Bundle size** per page: all JS chunks and WASM the page loads, raw and gzip (level 9), from the Vite manifest
([`scripts/bundle-sizes.ts`](scripts/bundle-sizes.ts)).

**Browsers.** Chromium runs in Playwright's new headless mode (`channel: 'chromium'`, the full browser), because
`measureUserAgentSpecificMemory()` is not available in the headless shell; it gets `--js-flags=--expose-gc`,
`--enable-blink-features=ForceEagerMeasureMemory` and `--enable-precise-memory-info`, which only affect memory
measurement. Firefox and WebKit run with Playwright's defaults and have no memory column. Playwright's WebKit is not
Safari, and Playwright's Firefox is a patched build.

## Datasets and queries

| Dataset | Triples | Queries |
|---|---:|---|
| `watdiv-1` (WatDiv scale factor 1) | 110,889 | 20 templates C1–C3, F1–F5, L1–L5, S1–S7 × 5 instances |
| `watdiv-10` (WatDiv scale factor 10) | 1,097,705 | same templates, 5 instances each |
| `bsbm-100` (BSBM, 100 products) | 40,377 | explore Q1–Q5, Q8–Q12 × 5 instances |
| `bsbm-1k` (BSBM, 1000 products) | 374,911 | same |
| `ldbc-snb-0.1` (LDBC SNB Interactive, scale factor 0.1) | 4,028,513 | short IS1–IS7 and complex IC1–IC14 × 5 instances |

Generated with jbr in [comunica/Experiments-Centralized](https://github.com/comunica/Experiments-Centralized) (LDBC SNB
from its open [#7](https://github.com/comunica/Experiments-Centralized/pull/7)); generator versions, seeds and the
deviations from the requested parameters are in [`data/README.md`](data/README.md). The support pass runs at the
smallest scale of each family (`watdiv-1`, `bsbm-100`); for LDBC SNB, which has one scale, the support matrix uses the
cold pass of the first timing repetition, which is the same procedure.

## Layout

```
src/harness.ts            in-page: fetch+inflate, init, load, memory, support/cold/warmup/timed steps, events
src/protocol.ts           messages between harness and runner, outcome classes
src/adapters/             comunica.ts, oxigraph.ts (+ oxigraph-query.ts shared with Node, oxigraph-breakdown.ts), types.ts
src/pages/                comunica.html, oxigraph.html
src/runner.ts             Playwright runner, static server with COOP+COEP, crash/hang recovery, resumable
src/reference.ts          Node reference counts (+ reference-oxigraph-worker.ts, node-chunks.ts)
src/node-runner.ts        the benchmark's steps for Comunica in Node, in the runner's raw format
scripts/prepare.mjs       build and link Comunica, fetch release assets, install browsers
scripts/bundle-sizes.ts   bundle sizes from the Vite manifest; fails if a Comunica module is not from the checkout
scripts/aggregate.ts      raw JSON -> CSVs (Experiments-Centralized column shape), totals, support matrix, README tables
scripts/plot.ts           SVG charts (+ plot-split.ts: evaluation vs transfer, plot-warmup.ts, plot-common.ts)
scripts/compare.ts        before/after comparison of the timing runs of two results directories
scripts/generate-data.sh  dataset generation with jbr (+ capture-bsbm-queries.mjs, split-ldbc-queries.mjs)
scripts/diagnostics/      one-off checks cited in the results notes (not part of the pipeline)
data/<dataset>/           dataset.nt.gz, queries/*.sparql, reference.json, generation.json
results/<date>-<machine>/ meta.json, bundle-sizes.csv, support-matrix.csv, raw/*.json, <dataset>/*.csv|svg, README.md
.github/workflows/bench.yml  workflow_dispatch + monthly run on a GitHub runner, opens a PR with the results
```

The per-template CSVs (`<dataset>/plot_<browser>.csv`) use the Experiments-Centralized shape
`query;<engine>-mean;<engine>-minus;<engine>-plus;…`: mean over the template's `ok` instances of their warm means,
minus = mean − fastest instance, plus = slowest instance − mean. The cold columns are named `<engine>-cold-*` instead of
`first-*`, because in Experiments-Centralized `first` means time to first result, which does not exist for Oxigraph's
array results.

## Caveats

- One machine per results directory. The committed run is a 4-vCPU cloud VM; neighbours on the same host can add noise.
  Compare engines within a run, not across runs.
- "Cold" is the first execution of each query on a freshly loaded page, but the queries before it in the cold pass have
  already warmed up the engine's code; only the first query of the pass is cold in every sense.
- Oxigraph's `Store.query()` is synchronous and blocks the page's main thread while it runs; Comunica yields to the
  event loop. That matters for applications but is not measured here.
- The Comunica numbers include N3.js and rdf-stores, because that is the stack that queries local data with the lite
  engine. Oxigraph's include its own parser and store.
- Correctness is checked by result count only. Many WatDiv instances have zero results (62/100 at scale 1, 41/100 at
  scale 10), for which a matching count proves little; the raw files also carry a checksum.
- Engine init includes fetching the adapter chunk from a local server, which is near-instant here and would not be on a
  real network.
- LDBC SNB ran once per configuration (one repetition took about 6 hours over all browsers), so its load and cold
  times are single samples; its warm times still come from 5 timed rounds. Configurations that cannot be completed on
  a machine are listed as skipped with the reason, as WebKit + Comunica on LDBC SNB is in the committed run.
