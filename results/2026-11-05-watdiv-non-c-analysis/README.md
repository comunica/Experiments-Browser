# WatDiv non-C queries: Comunica against Oxigraph, plans and profiles

Goal: make Comunica at least as fast as Oxigraph on the WatDiv templates other than C1–C3 (F1–F5, L1–L5, S1–S7),
starting from Comunica master `2cad759` with the open performance PRs merged (#1934, #1936, #1922, #1923, #1951,
#1952; not the parser PRs #1939 and #1950). Changes are kept on the Comunica branch
[`perf/watdiv-non-c`](https://github.com/comunica/comunica/tree/perf/watdiv-non-c).

All numbers are from Node 26.13.0 on the cloud VM (4 vCPU), both engines in one process, with
`scripts/quick-compare.ts` (10 warm-up rounds, 10 or 20 timed rounds, median per instance, all counts checked) and
`scripts/phases-comunica.ts`. Chromium runs Comunica within 0.84–1.01× of Node 26 on these datasets
(`../2026-11-05-cloud-4vcpu`), so Node stands in for the browser while iterating.

## Where the two engines stand

Mean per instance (median over the timed rounds); the last row is the geometric mean over instances of Comunica's time
divided by Oxigraph's. The first column is a single run; the second the median of 3 interleaved runs.

watdiv-1

| Template | Comunica, open PRs | + source cache | same, parsing excluded | Oxigraph |
|---|---:|---:|---:|---:|
| F1 | 1.34 ms | 1.07 ms | 866 µs | 123 µs |
| F2 | 1.54 ms | 1.20 ms | 1.04 ms | 137 µs |
| F3 | 1.48 ms | 1.05 ms | 811 µs | 103 µs |
| F4 | 1.83 ms | 1.42 ms | 1.10 ms | 149 µs |
| F5 | 2.43 ms | 1.71 ms | 1.61 ms | 607 µs |
| L1 | 1.65 ms | 1.26 ms | 1.16 ms | 227 µs |
| L2 | 1.15 ms | 858 µs | 737 µs | 141 µs |
| L3 | 1.15 ms | 878 µs | 785 µs | 230 µs |
| L4 | 893 µs | 713 µs | 590 µs | 56 µs |
| L5 | 1.15 ms | 853 µs | 682 µs | 95 µs |
| S1 | 2.89 ms | 2.35 ms | 2.58 ms | 568 µs |
| S2 | 1.19 ms | 931 µs | 803 µs | 122 µs |
| S3 | 1.26 ms | 944 µs | 747 µs | 95 µs |
| S4 | 1.30 ms | 932 µs | 833 µs | 282 µs |
| S5 | 1.20 ms | 819 µs | 740 µs | 79 µs |
| S6 | 1.12 ms | 762 µs | 680 µs | 69 µs |
| S7 | 869 µs | 624 µs | 449 µs | 73 µs |
| Geomean ÷ Oxigraph | 9.92× | 7.40× | 6.31× | 1.00× |

watdiv-10

| Template | Comunica, open PRs | + source cache | same, parsing excluded | Oxigraph |
|---|---:|---:|---:|---:|
| F1 | 1.24 ms | 1.16 ms | 736 µs | 635 µs |
| F2 | 1.56 ms | 1.48 ms | 988 µs | 247 µs |
| F3 | 1.65 ms | 1.51 ms | 1.08 ms | 315 µs |
| F4 | 1.80 ms | 1.70 ms | 1.17 ms | 420 µs |
| F5 | 2.49 ms | 2.30 ms | 1.79 ms | 1.00 ms |
| L1 | 1.17 ms | 1.10 ms | 715 µs | 308 µs |
| L2 | 1.35 ms | 1.28 ms | 891 µs | 701 µs |
| L3 | 990 µs | 915 µs | 562 µs | 359 µs |
| L4 | 1.08 ms | 951 µs | 602 µs | 246 µs |
| L5 | 1.12 ms | 1.06 ms | 682 µs | 567 µs |
| S1 | 2.92 ms | 3.23 ms | 2.19 ms | 771 µs |
| S2 | 1.83 ms | 1.71 ms | 1.25 ms | 1.01 ms |
| S3 | 1.68 ms | 1.55 ms | 1.09 ms | 596 µs |
| S4 | 1.54 ms | 1.51 ms | 1.06 ms | 2.74 ms |
| S5 | 1.44 ms | 1.35 ms | 941 µs | 205 µs |
| S6 | 1.03 ms | 920 µs | 562 µs | 175 µs |
| S7 | 810 µs | 693 µs | 384 µs | 91 µs |
| Geomean ÷ Oxigraph | 3.56× | 3.32× | 2.21× | 1.00× |

"Parsing excluded" passes Comunica the algebra, translated once outside the timing (`--preparsed`): even then
Comunica is slower on every template but S4 on watdiv-10. Oxigraph answers most of these queries in 60–300 µs in
total; Comunica needs 450–600 µs per query before parsing is counted.

## Query plans

Comunica's physical plans ([`comunica-plans-watdiv-1.txt`](comunica-plans-watdiv-1.txt), from the physical plan
logger) are what one would want for these shapes: one index nested loop join over all patterns of the BGP, starting
from the most selective pattern with a constant (for example S1-1 starts from the 48 offers of `Retailer2` and looks up
the other eight patterns per offer). The only waste in the plan is that every pattern is opened as a bindings stream,
with its cardinality and distinct-value counts computed, so that the join can be planned; all but the first are then
destroyed unread.

Oxigraph's plan could not be printed: its JavaScript API has no explain function, and running the Oxigraph CLI (which
has `query --explain`) was not permitted in this environment, so its plans are not verified here. On these queries
neither engine has much evaluation work to do (Comunica spends 170–215 µs consuming results, and most of that per
query rather than per result); the difference is the fixed cost per query.

## Where Comunica's time goes (watdiv-1, per query)

With the timings in [`comunica-phase-instrumentation.patch`](comunica-phase-instrumentation.patch) applied to Comunica
(mean over the 85 instances, µs; the patch is not on the branch):

| Phase | µs |
|---|---:|
| Context preprocessing | 27–31 |
| Parsing (traqula) | 150–170 |
| Translation to algebra | 60–75 |
| Optimizer pipeline (25 actors) | 228–236 |
| Evaluation until the result stream exists | 420–470 |
| Consuming the results | 170–215 |
| Total | 940–1,150 |

Largest parts of these:

- Optimizers: source identification 62 µs (removed by the first change below), the pipeline's test phase 27 µs,
  group-sources 24 µs, join-connected 22 µs, assign-sources-exhaustive 19 µs, join-bgp 10 µs, prune-empty-source
  operations 8 µs, and about 20 other actors at 2–6 µs each. Much of this is traqula's generic object transformer
  (`TransformerObject`), which every algebra traversal goes through: 6.5 % self time of the whole profile, about 4 %
  of it in optimizers.
- Evaluation: choosing the join actor takes 180 µs, including waiting for pattern metadata. Fifteen inner join actors
  are tested; the bind join, bind-source, smallest-filter-bindings, smallest and index nested loop actors each compute
  coefficients, and between them sort the entries 3.7 times and estimate selectivities 4.3 times per query. Computing
  the metadata of the patterns (counts and distinct counts in rdf-stores) takes about 85 µs, and opening the pattern
  streams about 130 µs.
- Self time per package over the whole profile ([`comunica-open-prs-watdiv-1.txt`](comunica-open-prs-watdiv-1.txt)):
  traqula 22 % (parser, algebra, transformer), rdf-stores 10.6 %, V8 and GC 9.7 %, `@comunica/core` 6.9 % (buses and
  mediators), asynciterator 4.3 %, Immutable.js 2.3 % (the action context), and many Comunica packages at 0.5–4 %.

Traqula on its own, in a loop over the same queries, parses one in 70–85 µs and translates it in 30–35 µs, about half
of what the same calls take inside the engine. The lexer's position tracking (`full` or `onlyOffset`) makes no
measurable difference.

## Changes so far

On [`perf/watdiv-non-c`](https://github.com/comunica/comunica/tree/perf/watdiv-non-c), after the merges of the open
PRs:

1. `0c13605` Cache identified sources that are objects, such as RDF/JS stores. Objects were identified again for every
   query (wrapping the store, creating a bindings factory); they are now cached by identity next to the cache by url.
   Interleaved A/B, 3 runs each: −8 to −26 % per template on watdiv-1 (geomean −20 %), −5 % on watdiv-10. The full
   Comunica test suite passes.

Run-to-run noise is large: two runs of the same build differ by up to 19 % in total, so changes of a few percent need
both builds compiled up front and run interleaved, with a discarded first run.

## Why parity is not reachable by tuning

Parsing and translation alone (about 200 µs in the engine, 100–120 µs at best) already exceed Oxigraph's whole query
time on 12 of the 17 templates on watdiv-1, and on S6 and S7 on watdiv-10. Without parsing, Comunica still needs 450–600 µs
per query, spread over about forty components that each cost 2–60 µs; no single one is more than about 6 % of the
total. Removing the largest remaining items would, as rough estimates from these measurements, save:

| Opportunity | Estimated saving per query |
|---|---:|
| Faster traqula parsing and translation (to the 100–120 µs it reaches on its own, or below) | 80–150 µs |
| Faster algebra traversal in traqula's transformer, or fewer full-tree passes in the optimizers | 50–100 µs |
| Join planning: compute sorted entries and selectivities once per join, not per actor | 40–80 µs |
| Pattern metadata: distinct-value counts only when a planner asks for them | 30–60 µs |
| Pattern streams that are only opened once read | 30–60 µs |
| Action context without Immutable.js | 20–30 µs |
| rdf-stores lookups without stringifying terms (`encodeOptional`) | 10–30 µs |

Together that is about 260–510 µs out of 1–1.2 ms, so Comunica would still take roughly 0.5–0.8 ms per query on
watdiv-1 against Oxigraph's 0.06–0.6 ms. Matching Oxigraph on these queries needs a query pipeline whose fixed cost is
around 100 µs, which means far fewer actor and mediator calls per query (or a fast path past them for simple BGPs) and
a parser several times faster than traqula; neither is a tuning change.

## Reproducing

- `npx tsx scripts/quick-compare.ts [--datasets watdiv-1,watdiv-10] [--engines comunica,oxigraph]
  [--oxigraph-cache file.json] [--preparsed] [--rounds 20]`
- `npx tsx scripts/phases-comunica.ts --dataset watdiv-1 [--explain]` (with the instrumentation patch applied and
  Comunica rebuilt with `npx tsc`, it also lists the time per mediator and optimizer actor)
- `npm run profile:comunica -- --dataset watdiv-1 --exclude C1,C2,C3 --rounds 40`
