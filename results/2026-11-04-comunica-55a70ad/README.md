# Comunica master `55a70ad` (with rdf-stores 2.9.0): WatDiv and BSBM

Comunica master gained one commit after `483dc3c`: `55a70ad` "Skip skolemization for patterns over sources without
blank nodes" (comunica/comunica#1940). When a source reports `hasBlankNodes === false`, pattern queries go straight
to it instead of through the skolemization wrapper, which otherwise rewrites every result binding. `RdfStore` reports
`hasBlankNodes` from **rdf-stores 2.9.0** on; with 2.8.0, which this benchmark used until now, the property is missing and
the commit changes nothing here. The commit also raises Comunica's own dependency to `rdf-stores` ^2.9.0, so the
benchmark now uses 2.9.0 as well. rdf-stores 2.9.0 also changes the ordered index the benchmark uses (binary search
to the start of a pattern's range, a faster path in the term order), so its effect is measured separately.
None of the four datasets has blank nodes; `store.hasBlankNodes` is `false` after loading.

## How it ran

Three page builds, made before any timed pass and swapped in between passes; five timing passes back to back on
2026-11-04 on one machine (cloud VM, Intel Xeon @ 2.10 GHz, 4 vCPUs, 15.7 GiB RAM; Chromium 153.0.8010.12,
Firefox 155.0, WebKit 26.6), same settings as the main run (1 warmup + 5 timed rounds, 3 repetitions, 60 s timeout):

| Pass | Directory | Comunica | rdf-stores | Engines | UTC |
|---|---|---|---|---|---|
| 1 | [`1-483dc3c-rdf-stores-2.8.0`](1-483dc3c-rdf-stores-2.8.0) | `483dc3c` | 2.8.0 | Comunica, Oxigraph | 19:26 to 19:49 |
| 2 | [`2-483dc3c-rdf-stores-2.9.0`](2-483dc3c-rdf-stores-2.9.0) | `483dc3c` | 2.9.0 | Comunica | 19:49 to 19:55 |
| 3 | [`3-55a70ad-rdf-stores-2.9.0`](3-55a70ad-rdf-stores-2.9.0) | `55a70ad` | 2.9.0 | Comunica, Oxigraph | 19:55 to 20:17 |
| 4 | [`4-483dc3c-rdf-stores-2.9.0-again`](4-483dc3c-rdf-stores-2.9.0-again) | `483dc3c` | 2.9.0 | Comunica | 20:17 to 20:23 |
| 5 | [`5-483dc3c-rdf-stores-2.8.0-again`](5-483dc3c-rdf-stores-2.8.0-again) | `483dc3c` | 2.8.0 | Comunica | 20:23 to 20:29 |

Every raw file and `meta.json` names the Comunica commit and rdf-stores version of the page that ran. All 132,300
executions in the five passes returned the reference count.

## Result

Change of a typical query: the geometric mean over instances of the per-instance ratio, where an instance's time is
the median over repetitions of its warm mean. Negative means faster. The noise columns compare passes of the same
build.

| Dataset | Browser | New master vs previous | Commit only (vs passes 2+4) | Commit only (vs pass 4) | rdf-stores 2.9.0 only | Noise: pass 1 vs 5 | Noise: pass 2 vs 4 | Noise: Oxigraph pass 1 vs 3 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| watdiv-1 | chromium | −5.5 % | −8.6 % | −6.7 % | +3.4 % | −3.6 % | −3.9 % | +2.1 % |
| watdiv-1 | firefox | +5.6 % | +4.4 % | +9.1 % | +1.2 % | −3.2 % | −8.5 % | −1.4 % |
| watdiv-1 | webkit | −2.9 % | −2.0 % | +0.7 % | −0.9 % | −0.8 % | −5.8 % | +3.4 % |
| watdiv-10 | chromium | −8.3 % | −4.6 % | −3.5 % | −3.9 % | +4.0 % | −2.6 % | −0.2 % |
| watdiv-10 | firefox | −3.9 % | −5.6 % | −1.3 % | +1.8 % | +2.0 % | −8.5 % | +0.6 % |
| watdiv-10 | webkit | −14.4 % | −9.9 % | −8.5 % | −5.0 % | +0.3 % | −1.5 % | +3.9 % |
| bsbm-100 | chromium | −5.8 % | −1.7 % | −0.0 % | −4.1 % | +2.7 % | −3.2 % | −2.9 % |
| bsbm-100 | firefox | −7.6 % | −7.6 % | −5.1 % | +0.1 % | +3.1 % | −4.5 % | +0.4 % |
| bsbm-100 | webkit | −7.1 % | −5.0 % | −4.1 % | −2.2 % | +1.8 % | −3.1 % | +6.1 % |
| bsbm-1k | chromium | −6.1 % | −7.0 % | −2.6 % | +1.1 % | +2.8 % | −7.4 % | −0.9 % |
| bsbm-1k | firefox | −6.3 % | −5.7 % | −1.1 % | −0.7 % | −2.1 % | −9.3 % | +0.8 % |
| bsbm-1k | webkit | −6.2 % | −3.9 % | −1.0 % | −2.4 % | −4.4 % | −6.2 % | −1.7 % |

- **New master against the previous one** (pass 3 against passes 1 and 5): Comunica is faster in 11 of 12
  configurations, by 3 to 14 % (median 6 %), most on watdiv-10 in WebKit (−14 %). The exception is watdiv-1 in Firefox
  (+5.6 %).
- **rdf-stores 2.9.0 alone** (passes 2 and 4 against 1 and 5): −5.0 % to +3.4 %, no consistent change.
- **The commit alone** (pass 3 against passes 2 and 4): 2 to 10 % faster in 11 of 12 configurations. Against pass 4
  alone, which ran right after pass 3 and was faster than pass 2, it is −8.5 % to +9.1 %, median −2 %. Passes 2
  and 4 of the same build differ by up to 9 %, so this run cannot pin the commit's own effect down further than "a
  few percent faster". The gains are spread over many templates, not concentrated in a few, which fits removing work
  per binding.
- **Noise**: the same build differs by up to 4.4 % between passes 1 and 5, and Oxigraph by up to 6.1 % between passes
  1 and 3; passes 2 and 4 differ by up to 9.3 %.

## Against Oxigraph

Totals are the median over repetitions of the sum of warm means. "Old" is pass 1, "new" is pass 3; each ratio uses
the Oxigraph times of its own pass.

| Dataset | Browser | Comunica, old | Comunica, new | Oxigraph (pass 3) | Comunica ÷ Oxigraph, typical query, old | new | Templates where Comunica is faster (new) |
|---|---|---:|---:|---:|---:|---:|---|
| watdiv-1 | chromium | 225 ms | 202 ms | 922 ms | 3.52× | 3.18× | C3 |
| watdiv-1 | firefox | 652 ms | 652 ms | 1.06 s | 8.14× | 8.58× | C3 |
| watdiv-1 | webkit | 269 ms | 258 ms | 1.02 s | 4.00× | 3.74× | C3 |
| watdiv-10 | chromium | 849 ms | 819 ms | 10.04 s | 1.95× | 1.83× | C2, C3, S4 |
| watdiv-10 | firefox | 1.85 s | 1.79 s | 11.23 s | 4.44× | 4.26× | C3 |
| watdiv-10 | webkit | 1.20 s | 1.03 s | 11.04 s | 2.62× | 2.16× | C2, C3 |
| bsbm-100 | chromium | 162 ms | 158 ms | 38 ms | 5.01× | 4.95× | none |
| bsbm-100 | firefox | 669 ms | 639 ms | 49 ms | 14.07× | 13.11× | none |
| bsbm-100 | webkit | 204 ms | 191 ms | 41 ms | 6.45× | 5.68× | none |
| bsbm-1k | chromium | 213 ms | 204 ms | 178 ms | 3.71× | 3.57× | Q8 |
| bsbm-1k | firefox | 1.00 s | 921 ms | 195 ms | 10.98× | 10.07× | Q8 |
| bsbm-1k | webkit | 306 ms | 250 ms | 188 ms | 4.94× | 4.55× | Q8 |

The gap narrows slightly in 11 of 12 configurations (most on watdiv-10 in WebKit, 2.62× to 2.16×); Oxigraph remains
faster on almost every query. Comunica wins on the same templates as before: WatDiv C3 everywhere, BSBM Q8 on bsbm-1k, and
on watdiv-10 C2 in Chromium and (new in this pass) WebKit, and S4 in Chromium (new in this pass).

## Comparisons

### New master (pass 3) against the previous master (passes 1 and 5)

A: `results/2026-11-04-comunica-55a70ad/1-483dc3c-rdf-stores-2.8.0` + `results/2026-11-04-comunica-55a70ad/5-483dc3c-rdf-stores-2.8.0-again`; B: `results/2026-11-04-comunica-55a70ad/3-55a70ad-rdf-stores-2.9.0`.
Totals: median (min–max) over repetitions of the sum of warm means over the common instances. Ratio = B ÷ A; negative % means B is faster.

| Dataset | Browser | Engine | Instances | Reps A | Reps B | Total A | Total B | Median total B ÷ A | Geomean of ratios | Faster by >10 % | Slower by >10 % |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| watdiv-1 | chromium | comunica | 100 | 6 | 3 | 218 ms (204 ms–231 ms) | 202 ms (194 ms–209 ms) | −7.7 % | −5.5 % | 41 | 11 |
| watdiv-1 | firefox | comunica | 100 | 6 | 3 | 637 ms (612 ms–684 ms) | 652 ms (579 ms–761 ms) | +2.4 % | +5.6 % | 6 | 31 |
| watdiv-1 | webkit | comunica | 100 | 6 | 3 | 269 ms (264 ms–290 ms) | 258 ms (244 ms–273 ms) | −3.8 % | −2.9 % | 29 | 12 |
| watdiv-10 | chromium | comunica | 100 | 6 | 3 | 865 ms (847 ms–925 ms) | 819 ms (788 ms–827 ms) | −5.3 % | −8.3 % | 49 | 8 |
| watdiv-10 | firefox | comunica | 100 | 6 | 3 | 1.86 s (1.75 s–1.96 s) | 1.79 s (1.75 s–1.79 s) | −4.0 % | −3.9 % | 24 | 5 |
| watdiv-10 | webkit | comunica | 100 | 6 | 3 | 1.22 s (1.14 s–1.42 s) | 1.03 s (1.02 s–1.06 s) | −15.1 % | −14.4 % | 70 | 3 |
| bsbm-100 | chromium | comunica | 50 | 6 | 3 | 168 ms (160 ms–184 ms) | 158 ms (157 ms–160 ms) | −5.8 % | −5.8 % | 16 | 2 |
| bsbm-100 | firefox | comunica | 50 | 6 | 3 | 683 ms (645 ms–722 ms) | 639 ms (605 ms–680 ms) | −6.5 % | −7.6 % | 23 | 2 |
| bsbm-100 | webkit | comunica | 50 | 6 | 3 | 206 ms (196 ms–217 ms) | 191 ms (186 ms–196 ms) | −7.3 % | −7.1 % | 27 | 3 |
| bsbm-1k | chromium | comunica | 50 | 6 | 3 | 223 ms (213 ms–234 ms) | 204 ms (184 ms–215 ms) | −8.4 % | −6.1 % | 16 | 3 |
| bsbm-1k | firefox | comunica | 50 | 6 | 3 | 984 ms (914 ms–1.05 s) | 921 ms (893 ms–971 ms) | −6.4 % | −6.3 % | 24 | 1 |
| bsbm-1k | webkit | comunica | 50 | 6 | 3 | 281 ms (257 ms–307 ms) | 250 ms (243 ms–265 ms) | −11.0 % | −6.2 % | 19 | 7 |

Per template (geometric mean over its instances, mean of the per-instance medians A → B):

- watdiv-1 / chromium / comunica: most faster L3 −12.9 % (1.22 ms → 1.06 ms), S6 −12.3 % (1.13 ms → 0.99 ms), F1 −12.2 % (1.43 ms → 1.25 ms); most slower F3 +5.5 % (1.24 ms → 1.31 ms), F4 +3.8 % (1.62 ms → 1.68 ms), S7 −1.1 % (0.91 ms → 0.89 ms)
- watdiv-1 / firefox / comunica: most faster C3 −9.6 % (32 ms → 29 ms), F2 −3.3 % (5.72 ms → 5.53 ms), S2 −0.5 % (4.53 ms → 4.52 ms); most slower S7 +17.8 % (2.99 ms → 3.50 ms), S5 +13.7 % (4.43 ms → 5.05 ms), F3 +13.4 % (4.82 ms → 5.47 ms)
- watdiv-1 / webkit / comunica: most faster L2 −16.5 % (1.59 ms → 1.34 ms), F5 −13.3 % (2.89 ms → 2.52 ms), L1 −9.3 % (1.74 ms → 1.58 ms); most slower S3 +7.0 % (1.37 ms → 1.47 ms), S5 +3.5 % (1.31 ms → 1.36 ms), S4 +3.3 % (1.60 ms → 1.66 ms)
- watdiv-10 / chromium / comunica: most faster S3 −21.7 % (1.90 ms → 1.49 ms), S2 −19.2 % (2.49 ms → 2.02 ms), S1 −18.4 % (2.86 ms → 2.33 ms); most slower F1 +6.4 % (1.69 ms → 1.79 ms), F2 +2.7 % (1.80 ms → 1.86 ms), L2 +1.2 % (1.53 ms → 1.56 ms)
- watdiv-10 / firefox / comunica: most faster S1 −11.9 % (8.64 ms → 7.59 ms), C1 −8.9 % (9.49 ms → 8.67 ms), F5 −8.5 % (7.99 ms → 7.30 ms); most slower S7 +7.4 % (3.29 ms → 3.49 ms), F1 +3.3 % (5.58 ms → 5.75 ms), F4 +1.0 % (6.68 ms → 6.75 ms)
- watdiv-10 / webkit / comunica: most faster F5 −28.3 % (4.75 ms → 3.40 ms), S4 −23.8 % (3.85 ms → 2.87 ms), C2 −21.7 % (13 ms → 9.97 ms); most slower L3 −6.3 % (2.52 ms → 2.35 ms), F3 −6.4 % (2.31 ms → 2.16 ms), L2 −6.7 % (2.89 ms → 2.72 ms)
- bsbm-100 / chromium / comunica: most faster Q8 −9.5 % (4.66 ms → 4.21 ms), Q10 −7.6 % (2.72 ms → 2.52 ms), Q1 −7.0 % (2.25 ms → 2.08 ms); most slower Q11 −2.3 % (0.97 ms → 0.95 ms), Q12 −3.0 % (2.28 ms → 2.21 ms), Q3 −4.8 % (3.81 ms → 3.62 ms)
- bsbm-100 / firefox / comunica: most faster Q5 −9.8 % (35 ms → 32 ms), Q9 −9.8 % (5.65 ms → 5.09 ms), Q8 −9.4 % (18 ms → 16 ms); most slower Q1 −5.1 % (7.67 ms → 7.27 ms), Q2 −5.5 % (15 ms → 15 ms), Q4 −6.4 % (13 ms → 12 ms)
- bsbm-100 / webkit / comunica: most faster Q12 −15.0 % (2.95 ms → 2.50 ms), Q3 −11.1 % (5.24 ms → 4.66 ms), Q10 −10.6 % (3.45 ms → 3.08 ms); most slower Q1 +0.9 % (2.84 ms → 2.88 ms), Q4 −1.5 % (3.83 ms → 3.78 ms), Q8 −3.5 % (5.42 ms → 5.24 ms)
- bsbm-1k / chromium / comunica: most faster Q5 −15.3 % (18 ms → 16 ms), Q2 −12.5 % (4.51 ms → 3.93 ms), Q4 −9.4 % (3.24 ms → 2.94 ms); most slower Q3 +2.2 % (3.24 ms → 3.33 ms), Q8 −2.2 % (4.81 ms → 4.71 ms), Q11 −3.4 % (0.95 ms → 0.92 ms)
- bsbm-1k / firefox / comunica: most faster Q11 −12.1 % (3.12 ms → 2.74 ms), Q8 −10.4 % (19 ms → 17 ms), Q1 −8.6 % (7.95 ms → 7.29 ms); most slower Q4 +0.3 % (12 ms → 12 ms), Q3 −3.7 % (14 ms → 14 ms), Q2 −3.8 % (16 ms → 16 ms)
- bsbm-1k / webkit / comunica: most faster Q5 −16.7 % (21 ms → 17 ms), Q12 −14.3 % (3.04 ms → 2.60 ms), Q9 −12.1 % (1.95 ms → 1.72 ms); most slower Q2 +7.5 % (5.67 ms → 6.12 ms), Q4 +5.8 % (3.87 ms → 4.09 ms), Q8 −2.7 % (6.25 ms → 6.05 ms)

### The commit: pass 3 against passes 2 and 4 (same rdf-stores 2.9.0)

A: `results/2026-11-04-comunica-55a70ad/2-483dc3c-rdf-stores-2.9.0` + `results/2026-11-04-comunica-55a70ad/4-483dc3c-rdf-stores-2.9.0-again`; B: `results/2026-11-04-comunica-55a70ad/3-55a70ad-rdf-stores-2.9.0`.
Totals: median (min–max) over repetitions of the sum of warm means over the common instances. Ratio = B ÷ A; negative % means B is faster.

| Dataset | Browser | Engine | Instances | Reps A | Reps B | Total A | Total B | Median total B ÷ A | Geomean of ratios | Faster by >10 % | Slower by >10 % |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| watdiv-1 | chromium | comunica | 100 | 6 | 3 | 230 ms (214 ms–257 ms) | 202 ms (194 ms–209 ms) | −12.2 % | −8.6 % | 54 | 10 |
| watdiv-1 | firefox | comunica | 100 | 6 | 3 | 650 ms (594 ms–742 ms) | 652 ms (579 ms–761 ms) | +0.3 % | +4.4 % | 8 | 27 |
| watdiv-1 | webkit | comunica | 100 | 6 | 3 | 263 ms (246 ms–303 ms) | 258 ms (244 ms–273 ms) | −1.9 % | −2.0 % | 29 | 18 |
| watdiv-10 | chromium | comunica | 100 | 6 | 3 | 849 ms (829 ms–989 ms) | 819 ms (788 ms–827 ms) | −3.6 % | −4.6 % | 34 | 11 |
| watdiv-10 | firefox | comunica | 100 | 6 | 3 | 1.88 s (1.80 s–1.97 s) | 1.79 s (1.75 s–1.79 s) | −4.7 % | −5.6 % | 32 | 2 |
| watdiv-10 | webkit | comunica | 100 | 6 | 3 | 1.14 s (1.11 s–1.20 s) | 1.03 s (1.02 s–1.06 s) | −9.5 % | −9.9 % | 52 | 4 |
| bsbm-100 | chromium | comunica | 50 | 6 | 3 | 159 ms (152 ms–167 ms) | 158 ms (157 ms–160 ms) | −0.5 % | −1.7 % | 9 | 3 |
| bsbm-100 | firefox | comunica | 50 | 6 | 3 | 684 ms (643 ms–701 ms) | 639 ms (605 ms–680 ms) | −6.7 % | −7.6 % | 17 | 1 |
| bsbm-100 | webkit | comunica | 50 | 6 | 3 | 200 ms (195 ms–219 ms) | 191 ms (186 ms–196 ms) | −4.4 % | −5.0 % | 19 | 4 |
| bsbm-1k | chromium | comunica | 50 | 6 | 3 | 217 ms (201 ms–238 ms) | 204 ms (184 ms–215 ms) | −5.7 % | −7.0 % | 22 | 4 |
| bsbm-1k | firefox | comunica | 50 | 6 | 3 | 981 ms (911 ms–1.05 s) | 921 ms (893 ms–971 ms) | −6.1 % | −5.7 % | 18 | 2 |
| bsbm-1k | webkit | comunica | 50 | 6 | 3 | 276 ms (250 ms–302 ms) | 250 ms (243 ms–265 ms) | −9.5 % | −3.9 % | 17 | 5 |

Per template (geometric mean over its instances, mean of the per-instance medians A → B):

- watdiv-1 / chromium / comunica: most faster C3 −18.6 % (17 ms → 14 ms), F1 −17.7 % (1.52 ms → 1.25 ms), L3 −15.6 % (1.26 ms → 1.06 ms); most slower L5 −0.3 % (1.13 ms → 1.12 ms), S5 −1.2 % (1.15 ms → 1.13 ms), F4 −2.0 % (1.71 ms → 1.68 ms)
- watdiv-1 / firefox / comunica: most faster C3 −10.1 % (32 ms → 29 ms), F2 −5.1 % (5.82 ms → 5.53 ms), S2 −0.5 % (4.54 ms → 4.52 ms); most slower S7 +14.6 % (3.09 ms → 3.50 ms), S6 +13.1 % (4.00 ms → 4.55 ms), F5 +12.4 % (6.37 ms → 7.18 ms)
- watdiv-1 / webkit / comunica: most faster L1 −11.2 % (1.78 ms → 1.58 ms), F1 −10.4 % (1.84 ms → 1.65 ms), L4 −10.4 % (1.35 ms → 1.21 ms); most slower S2 +6.7 % (1.44 ms → 1.53 ms), F3 +5.0 % (1.54 ms → 1.62 ms), S5 +4.0 % (1.30 ms → 1.36 ms)
- watdiv-10 / chromium / comunica: most faster S3 −16.5 % (1.78 ms → 1.49 ms), S2 −13.8 % (2.34 ms → 2.02 ms), S1 −12.7 % (2.68 ms → 2.33 ms); most slower F1 +9.6 % (1.63 ms → 1.79 ms), F5 +6.7 % (2.77 ms → 2.96 ms), F4 +3.3 % (2.05 ms → 2.12 ms)
- watdiv-10 / firefox / comunica: most faster S1 −14.6 % (8.89 ms → 7.59 ms), S2 −10.8 % (6.99 ms → 6.24 ms), S5 −8.6 % (4.61 ms → 4.21 ms); most slower S7 +1.7 % (3.46 ms → 3.49 ms), F4 +0.7 % (6.70 ms → 6.75 ms), F1 −0.7 % (5.78 ms → 5.75 ms)
- watdiv-10 / webkit / comunica: most faster F5 −31.2 % (4.94 ms → 3.40 ms), L1 −23.7 % (2.78 ms → 2.12 ms), S4 −13.9 % (3.34 ms → 2.87 ms); most slower L3 +4.7 % (2.24 ms → 2.35 ms), C2 +3.1 % (9.63 ms → 9.97 ms), C1 −2.3 % (5.11 ms → 5.03 ms)
- bsbm-100 / chromium / comunica: most faster Q1 −5.6 % (2.22 ms → 2.08 ms), Q10 −5.3 % (2.66 ms → 2.52 ms), Q4 −4.5 % (3.09 ms → 2.95 ms); most slower Q5 +2.5 % (6.94 ms → 7.10 ms), Q9 −0.5 % (1.36 ms → 1.35 ms), Q11 −0.5 % (0.95 ms → 0.95 ms)
- bsbm-100 / firefox / comunica: most faster Q9 −15.6 % (6.05 ms → 5.09 ms), Q12 −12.0 % (7.91 ms → 6.95 ms), Q8 −11.4 % (18 ms → 16 ms); most slower Q4 −0.2 % (12 ms → 12 ms), Q2 −3.1 % (15 ms → 15 ms), Q3 −3.2 % (16 ms → 16 ms)
- bsbm-100 / webkit / comunica: most faster Q3 −11.5 % (5.28 ms → 4.66 ms), Q10 −11.2 % (3.47 ms → 3.08 ms), Q12 −8.8 % (2.75 ms → 2.50 ms); most slower Q1 +4.7 % (2.73 ms → 2.88 ms), Q4 −0.5 % (3.77 ms → 3.78 ms), Q2 −1.9 % (4.84 ms → 4.74 ms)
- bsbm-1k / chromium / comunica: most faster Q4 −14.6 % (3.43 ms → 2.94 ms), Q2 −11.7 % (4.46 ms → 3.93 ms), Q12 −11.5 % (2.35 ms → 2.09 ms); most slower Q8 +5.7 % (4.44 ms → 4.71 ms), Q9 −0.1 % (1.38 ms → 1.37 ms), Q3 −1.1 % (3.34 ms → 3.33 ms)
- bsbm-1k / firefox / comunica: most faster Q12 −15.7 % (7.92 ms → 6.68 ms), Q8 −7.5 % (18 ms → 17 ms), Q9 −7.5 % (5.48 ms → 5.07 ms); most slower Q3 +1.8 % (13 ms → 14 ms), Q2 −2.1 % (16 ms → 16 ms), Q4 −2.4 % (12 ms → 12 ms)
- bsbm-1k / webkit / comunica: most faster Q5 −14.5 % (20 ms → 17 ms), Q9 −9.1 % (1.88 ms → 1.72 ms), Q12 −9.1 % (2.86 ms → 2.60 ms); most slower Q2 +16.0 % (5.29 ms → 6.12 ms), Q8 +1.3 % (5.97 ms → 6.05 ms), Q4 −1.0 % (4.12 ms → 4.09 ms)

### rdf-stores 2.9.0: passes 2 and 4 against passes 1 and 5 (same Comunica `483dc3c`)

A: `results/2026-11-04-comunica-55a70ad/1-483dc3c-rdf-stores-2.8.0` + `results/2026-11-04-comunica-55a70ad/5-483dc3c-rdf-stores-2.8.0-again`; B: `results/2026-11-04-comunica-55a70ad/2-483dc3c-rdf-stores-2.9.0` + `results/2026-11-04-comunica-55a70ad/4-483dc3c-rdf-stores-2.9.0-again`.
Totals: median (min–max) over repetitions of the sum of warm means over the common instances. Ratio = B ÷ A; negative % means B is faster.

| Dataset | Browser | Engine | Instances | Reps A | Reps B | Total A | Total B | Median total B ÷ A | Geomean of ratios | Faster by >10 % | Slower by >10 % |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| watdiv-1 | chromium | comunica | 100 | 6 | 6 | 218 ms (204 ms–231 ms) | 230 ms (214 ms–257 ms) | +5.1 % | +3.4 % | 1 | 18 |
| watdiv-1 | firefox | comunica | 100 | 6 | 6 | 637 ms (612 ms–684 ms) | 650 ms (594 ms–742 ms) | +2.1 % | +1.2 % | 4 | 11 |
| watdiv-1 | webkit | comunica | 100 | 6 | 6 | 269 ms (264 ms–290 ms) | 263 ms (246 ms–303 ms) | −1.9 % | −0.9 % | 16 | 7 |
| watdiv-10 | chromium | comunica | 100 | 6 | 6 | 865 ms (847 ms–925 ms) | 849 ms (829 ms–989 ms) | −1.8 % | −3.9 % | 17 | 1 |
| watdiv-10 | firefox | comunica | 100 | 6 | 6 | 1.86 s (1.75 s–1.96 s) | 1.88 s (1.80 s–1.97 s) | +0.8 % | +1.8 % | 4 | 12 |
| watdiv-10 | webkit | comunica | 100 | 6 | 6 | 1.22 s (1.14 s–1.42 s) | 1.14 s (1.11 s–1.20 s) | −6.2 % | −5.0 % | 30 | 10 |
| bsbm-100 | chromium | comunica | 50 | 6 | 6 | 168 ms (160 ms–184 ms) | 159 ms (152 ms–167 ms) | −5.3 % | −4.1 % | 6 | 0 |
| bsbm-100 | firefox | comunica | 50 | 6 | 6 | 683 ms (645 ms–722 ms) | 684 ms (643 ms–701 ms) | +0.2 % | +0.1 % | 5 | 5 |
| bsbm-100 | webkit | comunica | 50 | 6 | 6 | 206 ms (196 ms–217 ms) | 200 ms (195 ms–219 ms) | −3.1 % | −2.2 % | 11 | 3 |
| bsbm-1k | chromium | comunica | 50 | 6 | 6 | 223 ms (213 ms–234 ms) | 217 ms (201 ms–238 ms) | −2.9 % | +1.1 % | 5 | 3 |
| bsbm-1k | firefox | comunica | 50 | 6 | 6 | 984 ms (914 ms–1.05 s) | 981 ms (911 ms–1.05 s) | −0.3 % | −0.7 % | 2 | 3 |
| bsbm-1k | webkit | comunica | 50 | 6 | 6 | 281 ms (257 ms–307 ms) | 276 ms (250 ms–302 ms) | −1.7 % | −2.4 % | 12 | 6 |

Per template (geometric mean over its instances, mean of the per-instance medians A → B):

- watdiv-1 / chromium / comunica: most faster F5 −3.9 % (2.24 ms → 2.16 ms), S5 −3.6 % (1.19 ms → 1.15 ms), L5 −2.4 % (1.15 ms → 1.13 ms); most slower C3 +11.0 % (16 ms → 17 ms), F2 +10.3 % (1.59 ms → 1.76 ms), F3 +9.9 % (1.24 ms → 1.36 ms)
- watdiv-1 / firefox / comunica: most faster F5 −7.5 % (6.88 ms → 6.37 ms), S6 −3.8 % (4.16 ms → 4.00 ms), S1 −1.7 % (6.96 ms → 6.84 ms); most slower S3 +7.0 % (4.26 ms → 4.56 ms), F3 +6.5 % (4.82 ms → 5.13 ms), C1 +5.3 % (6.22 ms → 6.55 ms)
- watdiv-1 / webkit / comunica: most faster L2 −9.8 % (1.59 ms → 1.42 ms), S1 −9.0 % (2.84 ms → 2.57 ms), S6 −7.2 % (1.32 ms → 1.23 ms); most slower L4 +9.0 % (1.24 ms → 1.35 ms), L5 +5.5 % (1.35 ms → 1.43 ms), S4 +4.3 % (1.60 ms → 1.68 ms)
- watdiv-10 / chromium / comunica: most faster F5 −13.9 % (3.22 ms → 2.77 ms), C1 −12.0 % (3.69 ms → 3.25 ms), C2 −8.8 % (7.09 ms → 6.47 ms); most slower F2 +2.9 % (1.80 ms → 1.86 ms), F3 +2.4 % (1.82 ms → 1.87 ms), C3 +1.7 % (131 ms → 133 ms)
- watdiv-10 / firefox / comunica: most faster L2 −4.6 % (4.98 ms → 4.77 ms), F5 −3.2 % (7.99 ms → 7.73 ms), C1 −2.0 % (9.49 ms → 9.31 ms); most slower S7 +5.7 % (3.29 ms → 3.46 ms), L4 +5.1 % (4.29 ms → 4.50 ms), F2 +4.8 % (5.99 ms → 6.28 ms)
- watdiv-10 / webkit / comunica: most faster C2 −24.1 % (13 ms → 9.63 ms), S7 −14.5 % (1.68 ms → 1.46 ms), S4 −11.5 % (3.85 ms → 3.34 ms); most slower L1 +18.0 % (2.34 ms → 2.78 ms), F5 +4.3 % (4.75 ms → 4.94 ms), F1 +2.1 % (2.33 ms → 2.38 ms)
- bsbm-100 / chromium / comunica: most faster Q5 −9.3 % (7.64 ms → 6.94 ms), Q8 −9.0 % (4.66 ms → 4.23 ms), Q2 −5.1 % (4.58 ms → 4.34 ms); most slower Q4 −0.7 % (3.12 ms → 3.09 ms), Q1 −1.5 % (2.25 ms → 2.22 ms), Q11 −1.8 % (0.97 ms → 0.95 ms)
- bsbm-100 / firefox / comunica: most faster Q4 −6.3 % (13 ms → 12 ms), Q3 −4.2 % (17 ms → 16 ms), Q2 −2.6 % (15 ms → 15 ms); most slower Q9 +6.9 % (5.65 ms → 6.05 ms), Q12 +5.0 % (7.53 ms → 7.91 ms), Q11 +2.3 % (3.13 ms → 3.20 ms)
- bsbm-100 / webkit / comunica: most faster Q2 −7.8 % (5.24 ms → 4.84 ms), Q12 −6.7 % (2.95 ms → 2.75 ms), Q1 −3.7 % (2.84 ms → 2.73 ms); most slower Q11 +0.9 % (1.24 ms → 1.25 ms), Q10 +0.7 % (3.45 ms → 3.47 ms), Q3 +0.4 % (5.24 ms → 5.28 ms)
- bsbm-1k / chromium / comunica: most faster Q8 −7.5 % (4.81 ms → 4.44 ms), Q5 −4.9 % (18 ms → 17 ms), Q9 −3.5 % (1.42 ms → 1.38 ms); most slower Q12 +8.7 % (2.17 ms → 2.35 ms), Q11 +6.5 % (0.95 ms → 1.01 ms), Q4 +6.1 % (3.24 ms → 3.43 ms)
- bsbm-1k / firefox / comunica: most faster Q11 −6.7 % (3.12 ms → 2.91 ms), Q3 −5.4 % (14 ms → 13 ms), Q8 −3.1 % (19 ms → 18 ms); most slower Q12 +9.5 % (7.25 ms → 7.92 ms), Q5 +3.0 % (98 ms → 100 ms), Q4 +2.7 % (12 ms → 12 ms)
- bsbm-1k / webkit / comunica: most faster Q2 −7.3 % (5.67 ms → 5.29 ms), Q12 −5.8 % (3.04 ms → 2.86 ms), Q11 −5.6 % (1.30 ms → 1.22 ms); most slower Q4 +6.9 % (3.87 ms → 4.12 ms), Q3 +2.3 % (4.84 ms → 4.95 ms), Q1 +0.2 % (2.86 ms → 2.87 ms)

### Noise: Comunica `483dc3c` with rdf-stores 2.8.0, pass 1 against pass 5

A: `results/2026-11-04-comunica-55a70ad/1-483dc3c-rdf-stores-2.8.0`; B: `results/2026-11-04-comunica-55a70ad/5-483dc3c-rdf-stores-2.8.0-again`.
Totals: median (min–max) over repetitions of the sum of warm means over the common instances. Ratio = B ÷ A; negative % means B is faster.

| Dataset | Browser | Engine | Instances | Reps A | Reps B | Total A | Total B | Median total B ÷ A | Geomean of ratios | Faster by >10 % | Slower by >10 % |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| watdiv-1 | chromium | comunica | 100 | 3 | 3 | 225 ms (215 ms–231 ms) | 218 ms (204 ms–219 ms) | −3.0 % | −3.6 % | 17 | 3 |
| watdiv-1 | firefox | comunica | 100 | 3 | 3 | 652 ms (629 ms–684 ms) | 627 ms (612 ms–645 ms) | −4.0 % | −3.2 % | 21 | 4 |
| watdiv-1 | webkit | comunica | 100 | 3 | 3 | 269 ms (264 ms–290 ms) | 268 ms (265 ms–274 ms) | −0.1 % | −0.8 % | 16 | 15 |
| watdiv-10 | chromium | comunica | 100 | 3 | 3 | 849 ms (847 ms–913 ms) | 868 ms (862 ms–925 ms) | +2.2 % | +4.0 % | 4 | 21 |
| watdiv-10 | firefox | comunica | 100 | 3 | 3 | 1.85 s (1.75 s–1.96 s) | 1.86 s (1.86 s–1.90 s) | +0.5 % | +2.0 % | 6 | 15 |
| watdiv-10 | webkit | comunica | 100 | 3 | 3 | 1.20 s (1.18 s–1.24 s) | 1.26 s (1.14 s–1.42 s) | +5.1 % | +0.3 % | 19 | 22 |
| bsbm-100 | chromium | comunica | 50 | 3 | 3 | 162 ms (160 ms–184 ms) | 172 ms (164 ms–180 ms) | +6.3 % | +2.7 % | 4 | 9 |
| bsbm-100 | firefox | comunica | 50 | 3 | 3 | 669 ms (664 ms–697 ms) | 716 ms (645 ms–722 ms) | +7.1 % | +3.1 % | 3 | 12 |
| bsbm-100 | webkit | comunica | 50 | 3 | 3 | 204 ms (199 ms–217 ms) | 208 ms (196 ms–210 ms) | +1.9 % | +1.8 % | 10 | 12 |
| bsbm-1k | chromium | comunica | 50 | 3 | 3 | 213 ms (213 ms–226 ms) | 232 ms (220 ms–234 ms) | +8.6 % | +2.8 % | 1 | 9 |
| bsbm-1k | firefox | comunica | 50 | 3 | 3 | 1.00 s (914 ms–1.05 s) | 967 ms (942 ms–1.03 s) | −3.4 % | −2.1 % | 11 | 8 |
| bsbm-1k | webkit | comunica | 50 | 3 | 3 | 306 ms (257 ms–307 ms) | 277 ms (268 ms–284 ms) | −9.3 % | −4.4 % | 17 | 10 |

Per template (geometric mean over its instances, mean of the per-instance medians A → B):

- watdiv-1 / chromium / comunica: most faster S1 −11.2 % (2.28 ms → 2.03 ms), C1 −10.1 % (2.22 ms → 1.99 ms), S2 −7.6 % (1.39 ms → 1.29 ms); most slower S5 +4.6 % (1.17 ms → 1.22 ms), S7 +2.2 % (0.91 ms → 0.92 ms), F4 −0.4 % (1.62 ms → 1.62 ms)
- watdiv-1 / firefox / comunica: most faster S1 −12.6 % (7.51 ms → 6.58 ms), C2 −11.7 % (7.51 ms → 6.62 ms), C1 −7.1 % (6.50 ms → 6.05 ms); most slower L2 +5.9 % (4.01 ms → 4.26 ms), L3 +2.4 % (3.99 ms → 4.09 ms), L5 +1.9 % (4.02 ms → 4.09 ms)
- watdiv-1 / webkit / comunica: most faster L3 −13.6 % (1.85 ms → 1.59 ms), S1 −12.5 % (2.97 ms → 2.58 ms), S5 −7.5 % (1.36 ms → 1.26 ms); most slower F2 +6.9 % (1.77 ms → 1.89 ms), F1 +6.0 % (1.71 ms → 1.81 ms), C2 +5.9 % (2.59 ms → 2.74 ms)
- watdiv-10 / chromium / comunica: most faster L2 −7.6 % (1.62 ms → 1.50 ms), S1 −1.6 % (2.88 ms → 2.84 ms), S3 −1.3 % (1.90 ms → 1.88 ms); most slower F5 +20.4 % (2.86 ms → 3.45 ms), F4 +13.3 % (2.00 ms → 2.26 ms), C2 +10.2 % (6.82 ms → 7.51 ms)
- watdiv-10 / firefox / comunica: most faster F3 −5.2 % (5.98 ms → 5.67 ms), S5 −2.9 % (4.53 ms → 4.42 ms), L2 −2.3 % (5.05 ms → 4.94 ms); most slower L5 +7.5 % (4.57 ms → 4.94 ms), S7 +6.1 % (3.27 ms → 3.48 ms), L4 +5.7 % (4.22 ms → 4.46 ms)
- watdiv-10 / webkit / comunica: most faster C1 −15.7 % (6.20 ms → 5.20 ms), F5 −12.4 % (5.00 ms → 4.38 ms), S4 −4.5 % (3.98 ms → 3.67 ms); most slower L4 +14.7 % (1.95 ms → 2.26 ms), S6 +10.1 % (1.65 ms → 1.83 ms), S3 +10.0 % (2.46 ms → 2.74 ms)
- bsbm-100 / chromium / comunica: most faster Q2 −3.4 % (4.65 ms → 4.47 ms), Q11 −3.2 % (0.98 ms → 0.95 ms), Q10 −0.9 % (2.73 ms → 2.70 ms); most slower Q8 +10.4 % (4.38 ms → 4.84 ms), Q3 +7.4 % (3.66 ms → 3.92 ms), Q1 +7.3 % (2.13 ms → 2.28 ms)
- bsbm-100 / firefox / comunica: most faster Q9 −0.9 % (5.81 ms → 5.80 ms), Q11 +0.7 % (3.12 ms → 3.15 ms), Q10 +0.9 % (10 ms → 10 ms); most slower Q5 +8.5 % (34 ms → 37 ms), Q12 +6.4 % (7.28 ms → 7.72 ms), Q3 +5.9 % (17 ms → 18 ms)
- bsbm-100 / webkit / comunica: most faster Q5 −6.3 % (8.59 ms → 8.01 ms), Q9 −3.2 % (1.92 ms → 1.86 ms), Q8 −1.8 % (5.48 ms → 5.40 ms); most slower Q1 +8.6 % (2.74 ms → 2.99 ms), Q10 +6.3 % (3.44 ms → 3.68 ms), Q11 +5.9 % (1.21 ms → 1.29 ms)
- bsbm-1k / chromium / comunica: most faster Q3 −3.8 % (3.28 ms → 3.16 ms), Q10 −1.5 % (3.11 ms → 3.07 ms), Q4 −1.4 % (3.25 ms → 3.19 ms); most slower Q5 +11.5 % (18 ms → 20 ms), Q12 +7.6 % (2.07 ms → 2.23 ms), Q1 +7.0 % (1.89 ms → 2.02 ms)
- bsbm-1k / firefox / comunica: most faster Q12 −8.7 % (7.74 ms → 7.07 ms), Q2 −8.5 % (17 ms → 15 ms), Q8 −8.2 % (20 ms → 18 ms); most slower Q3 +11.1 % (13 ms → 15 ms), Q4 +4.9 % (12 ms → 12 ms), Q1 +1.9 % (7.88 ms → 8.04 ms)
- bsbm-1k / webkit / comunica: most faster Q5 −15.9 % (24 ms → 20 ms), Q4 −10.4 % (4.18 ms → 3.78 ms), Q11 −9.1 % (1.38 ms → 1.24 ms); most slower Q1 +16.0 % (2.63 ms → 3.08 ms), Q12 +4.5 % (3.09 ms → 3.25 ms), Q9 −2.6 % (1.98 ms → 1.94 ms)

### Noise: Comunica `483dc3c` with rdf-stores 2.9.0, pass 2 against pass 4

A: `results/2026-11-04-comunica-55a70ad/2-483dc3c-rdf-stores-2.9.0`; B: `results/2026-11-04-comunica-55a70ad/4-483dc3c-rdf-stores-2.9.0-again`.
Totals: median (min–max) over repetitions of the sum of warm means over the common instances. Ratio = B ÷ A; negative % means B is faster.

| Dataset | Browser | Engine | Instances | Reps A | Reps B | Total A | Total B | Median total B ÷ A | Geomean of ratios | Faster by >10 % | Slower by >10 % |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| watdiv-1 | chromium | comunica | 100 | 3 | 3 | 245 ms (222 ms–257 ms) | 224 ms (214 ms–235 ms) | −8.4 % | −3.9 % | 23 | 5 |
| watdiv-1 | firefox | comunica | 100 | 3 | 3 | 655 ms (650 ms–742 ms) | 608 ms (594 ms–650 ms) | −7.1 % | −8.5 % | 40 | 2 |
| watdiv-1 | webkit | comunica | 100 | 3 | 3 | 267 ms (264 ms–303 ms) | 262 ms (246 ms–263 ms) | −1.9 % | −5.8 % | 34 | 4 |
| watdiv-10 | chromium | comunica | 100 | 3 | 3 | 908 ms (847 ms–989 ms) | 842 ms (829 ms–851 ms) | −7.4 % | −2.6 % | 16 | 4 |
| watdiv-10 | firefox | comunica | 100 | 3 | 3 | 1.95 s (1.94 s–1.97 s) | 1.80 s (1.80 s–1.82 s) | −7.9 % | −8.5 % | 50 | 1 |
| watdiv-10 | webkit | comunica | 100 | 3 | 3 | 1.18 s (1.12 s–1.20 s) | 1.12 s (1.11 s–1.16 s) | −5.1 % | −1.5 % | 26 | 17 |
| bsbm-100 | chromium | comunica | 50 | 3 | 3 | 163 ms (160 ms–167 ms) | 158 ms (152 ms–158 ms) | −3.1 % | −3.2 % | 10 | 5 |
| bsbm-100 | firefox | comunica | 50 | 3 | 3 | 700 ms (699 ms–701 ms) | 662 ms (643 ms–670 ms) | −5.4 % | −4.5 % | 14 | 3 |
| bsbm-100 | webkit | comunica | 50 | 3 | 3 | 203 ms (197 ms–219 ms) | 198 ms (195 ms–202 ms) | −2.9 % | −3.1 % | 15 | 7 |
| bsbm-1k | chromium | comunica | 50 | 3 | 3 | 221 ms (215 ms–238 ms) | 202 ms (201 ms–218 ms) | −8.7 % | −7.4 % | 22 | 1 |
| bsbm-1k | firefox | comunica | 50 | 3 | 3 | 1.04 s (1.01 s–1.05 s) | 932 ms (911 ms–953 ms) | −10.3 % | −9.3 % | 26 | 2 |
| bsbm-1k | webkit | comunica | 50 | 3 | 3 | 280 ms (272 ms–287 ms) | 257 ms (250 ms–302 ms) | −8.2 % | −6.2 % | 21 | 8 |

Per template (geometric mean over its instances, mean of the per-instance medians A → B):

- watdiv-1 / chromium / comunica: most faster C3 −15.5 % (19 ms → 16 ms), C1 −11.2 % (2.32 ms → 2.05 ms), C2 −7.8 % (2.40 ms → 2.22 ms); most slower L5 +3.1 % (1.11 ms → 1.15 ms), F1 +2.5 % (1.49 ms → 1.52 ms), S1 +2.0 % (2.18 ms → 2.23 ms)
- watdiv-1 / firefox / comunica: most faster F5 −16.3 % (7.05 ms → 5.90 ms), F1 −14.6 % (5.88 ms → 5.01 ms), C2 −12.3 % (7.48 ms → 6.56 ms); most slower S1 +0.6 % (6.77 ms → 6.82 ms), S7 −4.5 % (3.15 ms → 3.01 ms), S4 −4.8 % (5.27 ms → 5.05 ms)
- watdiv-1 / webkit / comunica: most faster C2 −14.5 % (2.96 ms → 2.52 ms), F5 −11.1 % (2.96 ms → 2.63 ms), F2 −10.5 % (1.98 ms → 1.77 ms); most slower L3 +8.1 % (1.51 ms → 1.64 ms), C1 +6.0 % (2.35 ms → 2.50 ms), S3 −0.6 % (1.42 ms → 1.41 ms)
- watdiv-10 / chromium / comunica: most faster C3 −10.5 % (141 ms → 126 ms), S3 −7.7 % (1.88 ms → 1.74 ms), L3 −7.1 % (1.42 ms → 1.32 ms); most slower S7 +4.1 % (0.96 ms → 1.00 ms), S2 +2.4 % (2.31 ms → 2.37 ms), F3 +2.3 % (1.85 ms → 1.89 ms)
- watdiv-10 / firefox / comunica: most faster S2 −15.1 % (7.56 ms → 6.51 ms), C2 −14.5 % (18 ms → 16 ms), S7 −13.4 % (3.70 ms → 3.20 ms); most slower F3 −1.8 % (5.94 ms → 5.82 ms), L1 −2.5 % (4.76 ms → 4.63 ms), F4 −3.8 % (6.88 ms → 6.61 ms)
- watdiv-10 / webkit / comunica: most faster L1 −25.2 % (2.95 ms → 2.28 ms), S7 −17.1 % (1.55 ms → 1.26 ms), C2 −16.6 % (11 ms → 8.75 ms); most slower L3 +31.9 % (1.93 ms → 2.54 ms), L2 +15.9 % (2.73 ms → 3.14 ms), C1 +15.6 % (4.89 ms → 5.73 ms)
- bsbm-100 / chromium / comunica: most faster Q5 −12.8 % (7.57 ms → 6.57 ms), Q8 −8.5 % (4.42 ms → 4.03 ms), Q2 −7.6 % (4.48 ms → 4.14 ms); most slower Q12 +5.9 % (2.17 ms → 2.30 ms), Q1 +4.5 % (2.18 ms → 2.28 ms), Q11 +0.8 % (0.95 ms → 0.95 ms)
- bsbm-100 / firefox / comunica: most faster Q5 −17.5 % (37 ms → 31 ms), Q8 −13.9 % (20 ms → 17 ms), Q4 −9.5 % (12 ms → 11 ms); most slower Q9 +11.0 % (5.67 ms → 6.37 ms), Q3 +1.4 % (16 ms → 16 ms), Q12 +0.2 % (7.92 ms → 7.92 ms)
- bsbm-100 / webkit / comunica: most faster Q3 −10.1 % (5.66 ms → 5.07 ms), Q4 −7.0 % (4.05 ms → 3.70 ms), Q1 −6.1 % (2.84 ms → 2.67 ms); most slower Q9 +2.0 % (1.85 ms → 1.90 ms), Q10 +1.8 % (3.44 ms → 3.50 ms), Q2 −0.5 % (4.82 ms → 4.82 ms)
- bsbm-1k / chromium / comunica: most faster Q4 −14.3 % (3.58 ms → 3.08 ms), Q2 −12.9 % (4.81 ms → 4.18 ms), Q5 −10.9 % (18 ms → 16 ms); most slower Q8 +0.2 % (4.46 ms → 4.47 ms), Q12 −1.6 % (2.38 ms → 2.34 ms), Q9 −1.8 % (1.37 ms → 1.35 ms)
- bsbm-1k / firefox / comunica: most faster Q3 −16.2 % (15 ms → 13 ms), Q2 −13.4 % (17 ms → 15 ms), Q4 −13.2 % (13 ms → 12 ms); most slower Q12 −2.0 % (7.92 ms → 7.76 ms), Q9 −3.9 % (5.54 ms → 5.34 ms), Q8 −6.2 % (19 ms → 18 ms)
- bsbm-1k / webkit / comunica: most faster Q9 −19.4 % (2.12 ms → 1.70 ms), Q3 −13.9 % (5.41 ms → 4.58 ms), Q1 −12.7 % (3.21 ms → 2.76 ms); most slower Q2 +9.5 % (5.13 ms → 5.68 ms), Q10 +1.1 % (3.93 ms → 4.01 ms), Q4 +0.7 % (4.15 ms → 4.14 ms)

### Noise: Oxigraph, pass 1 against pass 3

A: `results/2026-11-04-comunica-55a70ad/1-483dc3c-rdf-stores-2.8.0`; B: `results/2026-11-04-comunica-55a70ad/3-55a70ad-rdf-stores-2.9.0`.
Totals: median (min–max) over repetitions of the sum of warm means over the common instances. Ratio = B ÷ A; negative % means B is faster.

| Dataset | Browser | Engine | Instances | Reps A | Reps B | Total A | Total B | Median total B ÷ A | Geomean of ratios | Faster by >10 % | Slower by >10 % |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| watdiv-1 | chromium | oxigraph | 100 | 3 | 3 | 916 ms (904 ms–960 ms) | 922 ms (900 ms–972 ms) | +0.6 % | +2.1 % | 4 | 15 |
| watdiv-1 | firefox | oxigraph | 100 | 3 | 3 | 1.16 s (998 ms–1.27 s) | 1.06 s (1.01 s–1.14 s) | −8.5 % | −1.4 % | 16 | 6 |
| watdiv-1 | webkit | oxigraph | 100 | 3 | 3 | 1.01 s (971 ms–1.03 s) | 1.02 s (1.01 s–1.09 s) | +1.5 % | +3.4 % | 7 | 25 |
| watdiv-10 | chromium | oxigraph | 100 | 3 | 3 | 10.00 s (9.51 s–10.43 s) | 10.04 s (9.91 s–10.65 s) | +0.4 % | −0.2 % | 8 | 6 |
| watdiv-10 | firefox | oxigraph | 100 | 3 | 3 | 11.43 s (11.21 s–11.75 s) | 11.23 s (11.05 s–12.03 s) | −1.8 % | +0.6 % | 14 | 17 |
| watdiv-10 | webkit | oxigraph | 100 | 3 | 3 | 10.94 s (10.91 s–11.32 s) | 11.05 s (10.82 s–11.10 s) | +1.0 % | +3.9 % | 5 | 19 |
| bsbm-100 | chromium | oxigraph | 50 | 3 | 3 | 39 ms (38 ms–40 ms) | 38 ms (37 ms–38 ms) | −0.9 % | −2.9 % | 9 | 3 |
| bsbm-100 | firefox | oxigraph | 50 | 3 | 3 | 49 ms (48 ms–50 ms) | 49 ms (47 ms–52 ms) | +0.3 % | +0.4 % | 6 | 4 |
| bsbm-100 | webkit | oxigraph | 50 | 3 | 3 | 39 ms (37 ms–41 ms) | 41 ms (39 ms–43 ms) | +5.0 % | +6.1 % | 1 | 14 |
| bsbm-1k | chromium | oxigraph | 50 | 3 | 3 | 177 ms (175 ms–188 ms) | 178 ms (168 ms–184 ms) | +0.5 % | −0.9 % | 7 | 4 |
| bsbm-1k | firefox | oxigraph | 50 | 3 | 3 | 196 ms (164 ms–196 ms) | 195 ms (194 ms–196 ms) | −0.4 % | +0.8 % | 5 | 5 |
| bsbm-1k | webkit | oxigraph | 50 | 3 | 3 | 176 ms (166 ms–177 ms) | 188 ms (167 ms–189 ms) | +6.4 % | −1.7 % | 10 | 4 |

Per template (geometric mean over its instances, mean of the per-instance medians A → B):

- watdiv-1 / chromium / oxigraph: most faster S1 −8.4 % (0.84 ms → 0.75 ms), C1 −6.1 % (0.63 ms → 0.59 ms), L5 −4.2 % (0.25 ms → 0.24 ms); most slower F2 +17.1 % (0.25 ms → 0.30 ms), F4 +6.8 % (0.30 ms → 0.32 ms), S2 +6.6 % (0.24 ms → 0.26 ms)
- watdiv-1 / firefox / oxigraph: most faster L3 −12.3 % (0.85 ms → 0.74 ms), C3 −8.7 % (220 ms → 200 ms), L4 −7.8 % (0.28 ms → 0.26 ms); most slower C1 +4.4 % (0.76 ms → 0.80 ms), S7 +4.0 % (0.30 ms → 0.31 ms), S6 +3.5 % (0.28 ms → 0.29 ms)
- watdiv-1 / webkit / oxigraph: most faster L2 −4.7 % (0.31 ms → 0.30 ms), F3 −3.9 % (0.23 ms → 0.22 ms), L3 −3.4 % (0.67 ms → 0.65 ms); most slower L5 +15.2 % (0.24 ms → 0.28 ms), C1 +8.0 % (0.63 ms → 0.68 ms), S4 +7.7 % (0.53 ms → 0.56 ms)
- watdiv-10 / chromium / oxigraph: most faster S5 −9.4 % (0.43 ms → 0.39 ms), C2 −5.7 % (12 ms → 11 ms), S3 −3.3 % (0.81 ms → 0.78 ms); most slower F5 +5.6 % (1.41 ms → 1.48 ms), C1 +4.8 % (1.60 ms → 1.68 ms), L2 +4.6 % (0.94 ms → 0.99 ms)
- watdiv-10 / firefox / oxigraph: most faster C1 −23.7 % (2.47 ms → 1.86 ms), C2 −13.1 % (13 ms → 12 ms), F5 −7.3 % (2.14 ms → 1.97 ms); most slower S1 +38.6 % (1.30 ms → 1.85 ms), L5 +35.4 % (1.07 ms → 1.45 ms), F3 +5.0 % (0.76 ms → 0.80 ms)
- watdiv-10 / webkit / oxigraph: most faster S3 −6.2 % (0.98 ms → 0.90 ms), S1 −4.6 % (1.31 ms → 1.24 ms), L3 −4.4 % (0.74 ms → 0.70 ms); most slower S7 +18.0 % (0.21 ms → 0.24 ms), C1 +12.1 % (1.75 ms → 1.96 ms), L5 +10.7 % (0.90 ms → 1.01 ms)
- bsbm-100 / chromium / oxigraph: most faster Q4 −10.1 % (0.47 ms → 0.42 ms), Q11 −7.0 % (0.29 ms → 0.27 ms), Q8 −4.4 % (2.92 ms → 2.80 ms); most slower Q12 +1.3 % (0.52 ms → 0.53 ms), Q3 −0.1 % (0.44 ms → 0.44 ms), Q1 −0.7 % (0.28 ms → 0.28 ms)
- bsbm-100 / firefox / oxigraph: most faster Q5 −7.3 % (1.28 ms → 1.19 ms), Q12 −5.2 % (0.70 ms → 0.67 ms), Q9 −3.3 % (0.39 ms → 0.38 ms); most slower Q11 +7.6 % (0.42 ms → 0.45 ms), Q10 +6.6 % (0.52 ms → 0.56 ms), Q3 +5.7 % (0.61 ms → 0.64 ms)
- bsbm-100 / webkit / oxigraph: most faster Q8 +2.0 % (2.85 ms → 2.88 ms), Q12 +2.0 % (0.50 ms → 0.51 ms), Q3 +2.3 % (0.45 ms → 0.46 ms); most slower Q1 +14.0 % (0.27 ms → 0.31 ms), Q9 +9.5 % (0.24 ms → 0.27 ms), Q10 +8.7 % (0.39 ms → 0.42 ms)
- bsbm-1k / chromium / oxigraph: most faster Q3 −10.8 % (0.46 ms → 0.41 ms), Q1 −6.7 % (0.33 ms → 0.31 ms), Q4 −4.8 % (0.48 ms → 0.46 ms); most slower Q12 +7.6 % (0.48 ms → 0.52 ms), Q9 +5.4 % (0.28 ms → 0.29 ms), Q11 +5.0 % (0.25 ms → 0.26 ms)
- bsbm-1k / firefox / oxigraph: most faster Q10 −2.1 % (0.66 ms → 0.65 ms), Q1 −0.4 % (0.44 ms → 0.44 ms), Q12 +0.1 % (0.74 ms → 0.74 ms); most slower Q4 +3.5 % (0.60 ms → 0.62 ms), Q3 +2.0 % (0.58 ms → 0.59 ms), Q9 +1.4 % (0.42 ms → 0.43 ms)
- bsbm-1k / webkit / oxigraph: most faster Q4 −9.1 % (0.49 ms → 0.44 ms), Q11 −6.6 % (0.30 ms → 0.28 ms), Q1 −2.8 % (0.33 ms → 0.33 ms); most slower Q8 +10.1 % (27 ms → 30 ms), Q12 +1.8 % (0.53 ms → 0.54 ms), Q2 −0.8 % (1.42 ms → 1.42 ms)
