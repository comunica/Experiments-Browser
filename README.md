# Comunica and Oxigraph in the browser

A reproducible comparison of two SPARQL engines running inside a browser tab over local RDF data:

- **Comunica**: `@comunica/query-sparql-rdfjs-lite`, built from a
  [comunica/comunica](https://github.com/comunica/comunica) master checkout, querying an ordered
  [`rdf-stores`](https://github.com/rubensworks/rdf-stores.js) store filled by the [N3.js](https://github.com/rdfjs/N3.js) parser.
- **Oxigraph**: the [`oxigraph`](https://www.npmjs.com/package/oxigraph) npm package (0.5.x, `web.js` WASM build) with its own
  in-memory store.

Both run the same WatDiv and BSBM queries over the same data in Chromium, Firefox and WebKit (headless, via Playwright).
Every query result is fully consumed and counted, counts are checked against reference counts, and failures are
published next to the timings. Federation, HTTP sources, Solid, updates and Node.js timings are out of scope.

## Results at a glance

From [`results/2026-11-01-cloud-4vcpu/`](results/2026-11-01-cloud-4vcpu/README.md) (4-vCPU cloud VM; Chromium 153,
Firefox 155, WebKit 26.6; Comunica master `e06d02e`, Oxigraph 0.5.13; 3 repetitions). Read the
[notes](results/2026-11-01-cloud-4vcpu/README.md#notes) before quoting any of this.

- Both engines returned the correct count for all 300 query instances in all three browsers.
- Per query, Oxigraph is faster on 17 to 20 of the 20 WatDiv templates and 9 to 10 of the 10 BSBM templates; Comunica
  is 2.1 to 15 times slower in geometric mean (least in Chromium, most in Firefox).
- WatDiv C3 is the exception: Oxigraph needs 2.0 to 2.6 s at 1.1M triples, Comunica 0.15 to 0.29 s. Because C3 is
  95 to 99 % of Oxigraph's WatDiv total, Comunica's WatDiv totals are lower; without C3, and on BSBM, Oxigraph's are.
- Loading takes the same order of time in both (which one is faster depends on browser and dataset); memory after
  load is lower for Comunica (91 vs 548 MB at 1.1M WatDiv triples); the Oxigraph page transfers 5.4 times more
  (1,542 vs 285 kB gzipped).

## Reproduce

```bash
git clone https://github.com/comunica/Experiments-Browser && cd Experiments-Browser
npm install            # also runs `prepare`
npm run prepare        # clone + build Comunica, link it, install Playwright browsers (idempotent)
npm run build          # Vite build of both pages, prints bundle sizes
npm run reference      # reference counts in Node, both engines -> data/*/reference.json
npm run bench          # support pass + full timing run -> results/<date>-<machine>/raw/*.json
npm run aggregate      # raw JSON -> CSVs, totals, support matrix, results README tables
npm run plot           # CSV -> SVG
```

- Linux needs the browsers' system libraries once: `npx playwright install-deps chromium firefox webkit`.
- `npm run prepare` builds Comunica at the commit pinned in `package.json` (`config.comunicaCommit`). Set
  `COMUNICA_REF=master` (or any branch, tag or commit) to build another one; the commit that was built is written to
  `.cache/comunica-build.json`, embedded in both pages, and recorded in every raw result and in `meta.json`.
- `npm run bench` is resumable: it skips configurations whose raw file exists (`--force` reruns them). Options:
  `--browsers`, `--engines`, `--datasets`, `--mode support|timing|all`, `--out`, `--machine` (or `BENCH_MACHINE`),
  `--timeout` (ms, default 60000), `--rounds` (5), `--warmup` (1), `--repeat` (3), and
  `--skip 'browser/engine/dataset=reason;…'` for configurations that cannot run on a machine (recorded in `meta.json`).
- `npm install <package>` removes the linked Comunica packages from `node_modules`; run `npm run prepare` again (the
  build refuses to run without them).
- Regenerating the datasets is not part of the pipeline (they are committed); see [`data/README.md`](data/README.md).

## What is compared

| | Comunica | Oxigraph |
|---|---|---|
| Package | `@comunica/query-sparql-rdfjs-lite`, from a comunica master checkout (`yarn install`, `yarn build`, linked like `npm link`) | `oxigraph` 0.5.13, `web.js` |
| Store | `RdfStore.createOrdered({ termComparator: compareTerms, nodes: true })`: GSOP, GPSO and GOPS indexes in term order, as comunica/comunica#1839 uses for files | Oxigraph's in-memory store |
| Loading | `new N3.Parser({ format: 'N-Triples' }).parse(text)`, then one `store.addQuads(quads)` batch (as in #1839) | `store.load(text, { format: 'application/n-triples' })` |
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
repeated (`--repeat`, default 3); repetitions are the outer loop, so a slow moment of the machine hits one repetition of
many configurations rather than all repetitions of one:

1. **Fetch + inflate**: fetch `dataset.nt.gz` and inflate it with `DecompressionStream` into a string. Timed, but not
   charged to the engine.
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
6. **Warmup**: one round over all queries, not used.
7. **Timed rounds**: five rounds over all queries (round-robin).

Over the repetitions: warm time = mean, min and max of all timed executions of an instance (3 × 5 = 15); cold time =
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
with the same store setup. Where they disagree, there is no reference count and the script fails instead of picking
one. For the committed data they agree on all 300 query instances.

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

Generated with jbr in [comunica/Experiments-Centralized](https://github.com/comunica/Experiments-Centralized); generator
versions, seeds and the deviations from the requested parameters are in [`data/README.md`](data/README.md). The support
pass runs at the smallest scale of each family (`watdiv-1`, `bsbm-100`).

## Layout

```
src/harness.ts            in-page: fetch+inflate, init, load, memory, support/cold/warmup/timed steps, events
src/protocol.ts           messages between harness and runner, outcome classes
src/adapters/             comunica.ts, oxigraph.ts (+ oxigraph-query.ts shared with Node), types.ts
src/pages/                comunica.html, oxigraph.html
src/runner.ts             Playwright runner, static server with COOP+COEP, crash/hang recovery, resumable
src/reference.ts          Node reference counts
scripts/prepare.mjs       build and link Comunica, fetch release assets, install browsers
scripts/bundle-sizes.ts   bundle sizes from the Vite manifest
scripts/aggregate.ts      raw JSON -> CSVs (Experiments-Centralized column shape), totals, support matrix, README tables
scripts/plot.ts           SVG charts
scripts/generate-data.sh  dataset generation with jbr (+ capture-bsbm-queries.mjs)
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
