# CPU profiles of Comunica in Node 26 (cloud, 4 vCPU)

Sampling CPU profiles of Comunica made with `npm run profile:comunica`, on the templates where Comunica is slower than
Oxigraph in the browsers (see [`../2026-11-05-cloud-4vcpu`](../2026-11-05-cloud-4vcpu/README.md)): all WatDiv
templates except C2 and C3 on watdiv-10, and all BSBM templates except Q8 on bsbm-1k. Each profile loads the dataset
and engine as the benchmark does, runs 10 warm-up rounds over the queries and then samples 30 rounds every 50 µs, in
Node 26.13.0 (V8 14.6). The first line of each `.txt` names the queries, the median round time and the Comunica commit.
Open a `.cpuprofile` in Chrome DevTools (Performance panel); `npm run profile:comunica -- --from <file>.cpuprofile`
summarizes one again.

| Profile | Comunica | Loader |
|---|---|---|
| `master-*` | master 6b5eb94 | N3's default data factory (before 12e8125) |
| `master-plus-1934-1936-1939-*` | 6b5eb94 with open PRs #1934, #1936 and #1939 merged locally (cc23151) | rdf-data-factory |
| `master-plus-1934-1936-1939-1923-*` | the same plus open PR #1923 (ad0fc15) | rdf-data-factory |
| `master-watdiv-10-C3` | master 6b5eb94, only C3, 3 warm-up and 8 profiled rounds, every 100 µs | rdf-data-factory |
| `unwrapped-sources-watdiv-10-C3` | the same with the first change below | rdf-data-factory |

The `master-*` profiles were recorded before the benchmark's loader switched to Comunica's data factory, so their store
holds N3's terms, which re-parse their id on every read (`n3` is 3 % inclusive on bsbm-1k). The other profiles use the
current loader.

## What they show

With the three PRs merged (cc23151), the median round drops from 224 to 144 ms on watdiv-10 and from 226 to 181 ms on
bsbm-1k (the master profile includes 3 to 4 % for N3's terms). In those profiles:

- rdf-stores, the ordered store, is the largest self-time package on WatDiv: `compare` 6.0 %, `label` 3.6 %,
  `prepareBindings` 2.7 %, `encodeOptional` 1.3 %, `seekKey` 1.0 % (26 % inclusive).
- The per-call check of the skolemization wrapper (#1940) is 3.1 % self on WatDiv and 1.2 % on BSBM.
- Join mediation (`mediateWith` in mediator-join-coefficients-fixed, `publish` in core) is about 3 % self on WatDiv.
- On BSBM, expression evaluation of the filters per binding is about 18 % inclusive
  (actor-expression-evaluator-factory-default), with `apply` in bus-function-factory and literal transformation on
  top; setting up the evaluator per query is about 1 %.
- With #1923 added (ad0fc15), the watdiv-10 round goes from 144 to 292 ms: C1 and C2 switch to hash joins and become
  about 7 times slower in the timing runs, while BSBM rounds go from 181 to 192 ms.

On C3 alone (`master-watdiv-10-C3`), the skolemization wrapper's per-call work is 8.3 % self
(`queryBindingsSynchronous` 3.1 %, `someTermsNested` 2.0 %, the term predicate 1.8 %, `canPassThrough` 1.4 %),
Immutable.js, which backs the bindings, is 25 % inclusive, and rdf-stores 42 %.

## Two changes that were measured and dropped

Both were measured as commits on master 6b5eb94, interleaved with master per repetition (build, then a timing run with
10 warm-up rounds), with `npm run compare`. Neither was pushed.

**Not wrapping sources that cannot contain blank nodes.** The skolemization optimizer would return a source as is when
`canContainBlankNodes()` is false, instead of wrapping it and checking per call (#1940).

| | watdiv-1 | watdiv-10 | bsbm-100 | bsbm-1k |
|---|---:|---:|---:|---:|
| Node 26, 6 repetitions each, geomean of ratios | −0.7 % | −4.3 % | −1.1 % | +3.5 % |
| Node 26, C3 (5 instances), median total | −10 % | −15 % | | |
| Chromium, 3 repetitions each, geomean of ratios | +2.7 % | −2.7 % | +0.1 % | +3.8 % |

The only gain beyond the noise is C3 in Node: on watdiv-10 its 5 instances take 4.36 to 5.27 s per repetition
against 5.45 to 5.87 s for master. Node runs C3 8 to 11 times slower than Chromium, and in Chromium C3 does not gain
(0.71 to 0.78 s against 0.64 to 0.82 s on watdiv-10, no change on watdiv-1). The geomeans of the other templates
are within the noise: two master runs in Node differ by up to 12 % (watdiv-1). Under the profiler, C3 was not faster
either (median round 6.37 s against 6.13 s). The change would also decide once per query whether a source can contain
blank nodes, while an rdf-stores store can gain them during a query (an update that inserts blank nodes), which the
per-call check of #1940 follows.

**Caching transformed terms per term object** in the expression evaluator's term transformer (a `WeakMap`), since the
store returns the same term objects every time. Node 26, 3 repetitions each, geomean of ratios: +3.7 % (watdiv-1),
−3.1 % (watdiv-10), +1.5 % (bsbm-100), +8.2 % (bsbm-1k).
