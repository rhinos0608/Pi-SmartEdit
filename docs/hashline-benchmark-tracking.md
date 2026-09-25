# Hashline benchmark tracking

This document is the durable ledger for SmartEdit's hashline-vs-normal agent benchmarks.
It records benchmark methodology, oracle corrections, model-specific results, failure
analysis, and cross-model findings. Generated raw runs under `benchmark/runs/` are local
artifacts and are intentionally ignored by Git; report paths are retained here for
traceability on machines that still have the raw runs.

The design comparison with oh-my-pi lives separately in
`docs/hashline-oh-my-pi-comparison.md`.

## Harness housekeeping

- Parallel benchmark processes use PID-suffixed run directories to avoid collisions.
- Generated raw reports and JSONL transcripts live under `benchmark/runs/` and are
  ignored by Git. Durable measurements and failure analysis belong in this document.

## Benchmark intent

The agent benchmark should answer two separate questions: final edit correctness and
protocol efficiency. Exact output remains the correctness oracle. Edit calls, semantic
edit failures, output/input/cache tokens, wall time, and protocol compliance measure
how much work each protocol makes the model and harness perform. Single-run deltas are
diagnostic, not statistical; the final comparison uses three independent parallel runs.

## Benchmark oracle notes

The expanded fixtures deliberately use exact-file grading, so whitespace in each expected
file is part of the oracle. During the first three-run pass, task 09 exposed an oracle
mistake: deleting only the marked block preserves both surrounding blank lines. Task 12
also exposed a prompt/oracle mismatch: the prompt explicitly says to keep the existing
blank line after the import and insert after it, so the expected file now does exactly
that. The fixture also includes its unchanged runtime dependency so compiler diagnostics
measure the edit rather than a broken baseline. These oracle fixes were made before the
final three-run comparison; model behavior that revealed a bad oracle is not counted as
a protocol failure.

## Final three-process Muse Spark benchmark

Model: `opencode-go/muse-spark-1.3-contributor`. Three independent benchmark
processes were launched concurrently against all 15 tasks in both modes.

Final report directories:

- `agent-2026-09-24T21-26-55-167Z-p12331`
- `agent-2026-09-24T21-26-55-167Z-p12332`
- `agent-2026-09-24T21-26-55-167Z-p12333`

One p12331 hashline task-07 invocation never reached the model because Pi-Atlas
failed to parse during extension startup (`Identifier 'spec' has already been
declared`). For a paired comparison, both modes for that one run/task pair are
excluded. That leaves 44 observations per mode.

| Metric | Hashline | Normal | Hashline delta |
| --- | ---: | ---: | ---: |
| Exact success | 43/44 (97.7%) | 41/44 (93.2%) | +4.5 pp |
| Avg wall time | 25,316 ms | 22,198 ms | +14.0% |
| Total tokens | 1,459,219 | 1,281,461 | +13.9% |
| Input tokens | 444,094 | 420,151 | +5.7% |
| Output tokens | 19,458 | 18,446 | +5.5% |
| Cache-read tokens | 995,667 | 842,864 | +18.1% |
| Reasoning tokens | 6,688 | 3,535 | +89.2% |
| Cost | $0.050292 | $0.047390 | +6.1% |
| Edit calls | 61 | 47 | +29.8% |
| Semantic edit errors | 13 | 3 | +333% |
| Protocol compliance | 78.7% | 100% | -21.3 pp |
| Timeouts | 0 | 0 | — |

The correctness advantage is concentrated in deletion behavior. Task 09
(`large-delete`) was exact in all three hashline runs and missed exact output
in all three normal runs: the normal model used `newText: "\n"` for a source
range that already excluded the surrounding blank lines, leaving one extra
blank line. Hashline's explicit deletion semantics preserved the surrounding
text exactly.

The one genuine hashline correctness miss was task 10 in p12332. The model sent
`edits` as a JSON string, then retried with only `path`; both calls were
rejected by schema validation before mutation. This is model/protocol
serialization friction, not a hashline engine matching failure.

The multi-file mechanical bug is fixed: every valid hashline task-07 and
task-14 execution completed without the previous `xxHash32 not initialized`
failure. Task 12 also passes in every valid final run after the fixture oracle
and unchanged runtime dependency were corrected, exercising the advertised
`:after` insertion form.

## Cross-model check: MiMo V2.6 Flash

Model: `opencode-go/mimo-v2.6-flash`. The same frozen 15-task suite was run
as three independent concurrent processes in both modes.

Reports:

- `agent-2026-09-24T21-48-48-887Z-p67428`
- `agent-2026-09-24T21-48-48-887Z-p67429`
- `agent-2026-09-24T21-48-48-887Z-p67430`

All 90 mode/task observations reached the benchmark and there were no benchmark
timeouts or infrastructure exclusions.

| Metric | Hashline | Normal | Hashline delta |
| --- | ---: | ---: | ---: |
| Exact success | 43/45 (95.6%) | 39/45 (86.7%) | +8.9 pp |
| Median wall time | 29,643 ms | 29,333 ms | +1.1% |
| Mean wall time | 44,223 ms | 31,385 ms | +40.9% |
| Total tokens | 1,951,327 | 1,602,402 | +21.8% |
| Input tokens | 394,406 | 349,447 | +12.9% |
| Output tokens | 36,729 | 17,179 | +113.8% |
| Cache-read tokens | 1,520,192 | 1,235,776 | +23.0% |
| Reasoning tokens | 26,784 | 3,969 | +574.8% |
| Cost | $0.069757 | $0.057193 | +22.0% |
| Edit calls | 62 | 51 | +21.6% |
| Semantic edit errors | 1 | 5 | -80.0% |
| Protocol compliance | 98.4% | 94.1% | +4.3 pp |
| Timeouts | 0 | 0 | — |

The mean/token penalty is dominated by one 592,470 ms hashline task-15 run.
Removing that single outlier as a sensitivity check makes typical efficiency
nearly even: hashline mean wall time is about +1.2%, total tokens -0.2%, and
cost -4.0% versus the full normal sample. This is not a paired replacement for
the main table, but it shows that the raw mean is not representative of normal
hashline behavior for MiMo.

Correctness generalizes. Normal mode was 0/3 exact on task 03 (delete block)
and 0/3 on task 09 (large delete), while hashline was 3/3 and 2/3 respectively.
The recurring normal-mode failure was whitespace preservation: oldText/newText
selected a syntactically reasonable deletion span but consumed or recreated a
neighboring blank line differently from the exact oracle.

The long task-15 hashline failure exposed a separate recovery-safety issue. The
read output showed line 4 as `4jk`, but MiMo sent `4we`, combining line 4
with the hash suffix from line 1 (`1we`). SmartEdit's ±5 rebase recovered that
malformed anchor to line 1 and applied a destructive replacement instead of
rejecting the inconsistent LINE+ID. The model made the primary anchor error,
but recovery amplified it. This supports adopting oh-my-pi's conservative
recovery principle: stale/mismatched anchors should be recovered only when the
mapping is uniquely and contextually safe; otherwise fail closed and require a
re-read.

Across Muse Spark 1.3 and MiMo V2.6 Flash, hashline therefore shows a repeatable
exact-correctness advantage, especially for deletion/whitespace-sensitive
tasks. The efficiency effect is model-dependent: Muse paid a fairly consistent
hashline overhead, whereas MiMo's typical hashline and normal costs were much
closer and the raw hashline mean was dominated by one catastrophic recovery
episode. Protocol adaptation is also model-dependent: Muse produced more
malformed hashline calls; MiMo was highly schema-compliant but made one
dangerous mixed LINE+ID anchor.

## Post-hardening Muse Spark rerun — 2026-09-25

After the recovery hardening, an initial live Muse run immediately exposed a separate
read-cache integration bug: SmartRead returned correct PINE-wrapped rows such as
`8sm|...`, but the cache treated the rendered envelope as raw file text and recomputed
different anchors. Muse repeatedly re-read and copied the correct `8sm`; SmartEdit
incorrectly rejected it as absent from the latest snapshot. The run was stopped rather
than counted.

The read seam was fixed to keep two representations: raw bytes read from disk for
freshness/fallback and the exact LINE+ID rows actually rendered to the model for
provenance. A dedicated PINE-envelope regression and partial-read provenance test pass,
and a one-task Muse smoke test then completed task 01 in one edit call with zero errors.

The clean final benchmark used `opencode-go/muse-spark-1.3-contributor`, three
independent processes, all 15 frozen tasks, and both modes. Reports:

- `agent-2026-09-25T00-02-47-642Z-p59001`
- `agent-2026-09-25T00-02-47-642Z-p59002`
- `agent-2026-09-25T00-02-47-647Z-p59003`

| Metric | Hashline | Normal | Hashline delta |
| --- | ---: | ---: | ---: |
| Exact success | 45/45 (100%) | 45/45 (100%) | 0 pp |
| Mean wall time | 24,111 ms | 22,984 ms | +4.9% |
| Median wall time | 22,172 ms | 23,259 ms | -4.7% |
| Total tokens | 1,352,379 | 1,307,310 | +3.4% |
| Input tokens | 432,363 | 434,934 | -0.6% |
| Output tokens | 15,110 | 17,744 | -14.8% |
| Cache-read tokens | 904,906 | 854,632 | +5.9% |
| Reasoning tokens | 3,399 | 2,845 | +19.5% |
| Cost | $0.048068 | $0.048751 | -1.4% |
| Edit calls | 51 | 48 | +6.3% |
| Edit errors | 2 | 3 | -1 call |
| Protocol compliance | 49/51 (96.1%) | 48/48 (100%) | -3.9 pp |
| Timeouts | 0 | 0 | — |

The safety regression is fixed. The final hashline transcripts contain no recurrence of
the earlier false provenance rejection and no case where a nearby two-letter hash is
allowed to redefine anchor identity. Most importantly, the adversarial
`12-line-shift-batch` fixture was 3/3 exact in hashline mode, with one edit call,
zero edit errors, and 100% protocol compliance in each worker. The MiMo
`4we -> 1we` failure mode is therefore no longer reachable through the public edit path.

Both protocols finished 45/45 exact. Relative to normal mode, hashline used 3.4% more
total tokens and had a 4.9% higher mean wall time, but a 4.7% lower median wall time and
1.4% lower measured model cost. Hashline also produced fewer edit errors (2 vs 3).
The execution penalty is therefore small in this Muse sample; the remaining measurable
difference is mostly provider/model adaptation to the stricter structured wire format.

The 96.1% weighted hashline compliance comes from one stochastic outlier in p59002 on
`08-insert-and-replace`. Muse first encoded the entire `edits` array as a JSON string,
then issued an empty path-only edit call, and finally retried with the correct native
array; the exact output was still produced. The other two identical task-08 samples were
clean one-call edits. An earlier reproducible form of this issue on task 03 disappeared
after the schema/tool prompt was changed to require a native JSON array and show the
complete top-level call shape.

SmartEdit intentionally continues to reject those malformed wire types rather than
silently parsing JSON strings into valid calls. Accepting them would hide protocol
noncompliance and weaken the typed boundary merely to improve a benchmark metric.
The final result is therefore 100% exact correctness with one measured model-side
serialization wobble, not a semantic recovery failure.

The final handoff gate passed on the finished tree: TypeScript typecheck, ESLint, the
complete npm test suite (including the PINE read-cache and crash-recovery regressions),
and `git diff --check` all exited cleanly.

## Post-hardening MiMo V2.6 Flash rerun — 2026-09-25

Model: `opencode-go/mimo-v2.6-flash`. Three independent processes ran the same
15 frozen tasks in both hashline and normal modes. The benchmark processes were launched
against the already-hardened tree before the two additive imports above were copied into
the working repo, so this is a clean measurement of the provenance/read-seam recovery
fixes rather than a moving target. Reports:

- `benchmark/runs/agent-2026-09-25T00-29-29-441Z-p49214/report.json`
- `benchmark/runs/agent-2026-09-25T00-29-32-219Z-p49307/report.json`
- `benchmark/runs/agent-2026-09-25T00-29-35-392Z-p49443/report.json`

| Metric | Hashline | Normal | Hashline delta |
| --- | ---: | ---: | ---: |
| Exact tasks | 44/45 (97.8%) | 40/45 (88.9%) | +8.9 pp |
| Edit calls | 55 | 51 | +7.8% |
| Edit errors | 0 | 4 | -4 |
| Weighted protocol compliance | 100% | 92.2% | +7.8 pp |
| Timeouts | 0 | 0 | 0 |
| Mean wall time | 32,163 ms | 34,398 ms | -6.5% |
| Median wall time | 29,862 ms | 31,478 ms | -5.1% |
| Total tokens | 1,600,896 | 1,657,607 | -3.4% |
| Input tokens | 353,011 | 338,017 | +4.4% |
| Output tokens | 16,205 | 19,302 | -16.0% |
| Cache-read tokens | 1,231,680 | 1,300,288 | -5.3% |
| Reasoning tokens | 7,708 | 6,155 | +25.2% |
| Measured cost | $0.05741 | $0.05637 | +1.8% |

Per-task exactness isolates the remaining misses. Hashline was 3/3 on every task except
`09-large-delete` (2/3). Normal mode was 1/3 on `03-delete-block`, 0/3 on
`09-large-delete`, and 3/3 on every other task. The previous high-risk
`12-line-shift-batch` and `15-tab-indentation` cases were both 3/3 exact in hashline mode.

The single hashline task-09 miss was not a recovery or protocol failure. The model made
one valid, fully compliant edit and deliberately included the blank line immediately
after the retired flag block in its deletion range. SmartEdit applied those exact anchors;
the benchmark oracle correctly marked the extra deletion as a content mismatch. There
were no hashline edit errors, malformed calls, timeouts, or mixed LINE+ID corruption in
the 45 observations.

Compared with normal mode, hashline gained 8.9 percentage points of exactness while also
using 3.4% fewer total tokens and finishing 6.5% faster on mean wall time in this sample.
Its measured model cost was 1.8% higher because the token mix differed, but the operational
signal is stronger: zero edit errors and 100% protocol compliance versus four edit errors
and 92.2% weighted compliance in normal mode.

## GPT-6 Luna stress test — 2026-09-25

Model: `openai-codex/gpt-6-luna`. Three independent benchmark processes ran all
15 frozen tasks in both hashline and normal modes. Reports:

- `benchmark/runs/agent-2026-09-25T01-00-12-620Z-p79751/report.json`
- `benchmark/runs/agent-2026-09-25T01-00-15-695Z-p79871/report.json`
- `benchmark/runs/agent-2026-09-25T01-00-19-546Z-p80077/report.json`

| Metric | Hashline | Normal | Hashline delta |
| --- | ---: | ---: | ---: |
| Exact tasks | 44/45 (97.8%) | 42/45 (93.3%) | +4.4 pp |
| Edit calls | 51 | 45 | +13.3% |
| Edit errors | 0 | 0 | 0 |
| Completed-call protocol compliance | 100% | 100% | 0 pp |
| Benchmark-reported timeouts | 0 | 0 | 0 |
| Mean wall time | 39,144 ms | 24,716 ms | +58.4% |
| Median wall time | 23,589 ms | 23,014 ms | +2.5% |
| Total tokens | 1,540,484 | 1,220,386 | +26.2% |
| Input tokens | 470,481 | 459,202 | +2.5% |
| Output tokens | 6,579 | 10,080 | -34.7% |
| Cache-read tokens | 1,063,424 | 751,104 | +41.6% |
| Reasoning tokens | 0 | 0 | 0 |
| Measured cost | $0.060972 | $0.058471 | +4.3% |

Per-task exactness was clean outside three cases. Hashline was 3/3 on every task except
`08-insert-and-replace` (2/3). Normal mode was 1/3 on `03-delete-block`, 2/3 on
`09-large-delete`, and 3/3 everywhere else. The adversarial `12-line-shift-batch`
and `15-tab-indentation` tasks remained 3/3 exact in hashline mode.

The three normal-mode misses were semantic whitespace overshoots, not SmartEdit
rejections. In both failing task-03 runs Luna included the blank line immediately after
the three requested debug lines in `oldText`; the one passing run omitted that blank
line. The task-09 miss repeated the same pattern on the much larger retired-flag block:
the failing `oldText` consumed the following blank line, while the two exact runs ended
the deletion at the END marker. All three calls were valid, one-shot edits with 100%
protocol compliance, and SmartEdit applied exactly what the model requested.

The single hashline miss was qualitatively different. On p80077 task 08 Luna first read
`src/parse.ts`, then started an `edit` tool call but never completed it. The JSONL
contains 33,562 streaming update events; after a short malformed partial edit payload,
the stream emitted about 66 KB of almost entirely whitespace/newlines. No
`tool_execution_start` for `edit` occurred, so SmartEdit never received or rejected
the request. The Pi child exited with code 143 after 618,108 ms; the benchmark timeout
was disabled and stderr was empty. The trace therefore proves an unfinished
model/provider/runtime tool-call stream, but does not identify which inner layer sent
the terminating signal.

That event exposes a measurement caveat: the benchmark's protocol-compliance percentage
is calculated over completed edit calls. It reports 100% for Luna because all 51
completed hashline edit calls were valid, even though the unfinished task-08 edit stream
was plainly noncompliant at the generation boundary. Future benchmark revisions should
track started-but-unfinished tool calls separately rather than folding them into
correctness/latency alone.

The 618-second event dominates raw mean latency but not the median. In a paired
sensitivity check that removes p80077 task 08 from both modes, hashline is 44/44 exact
versus normal 41/44, with mean wall time 25,986 ms versus 24,723 ms (+5.1%) and median
23,588 ms versus 22,999 ms (+2.6%). Hashline still uses materially more total tokens
(1,532,388 vs 1,188,700, +28.9%) and costs about 5.1% more in that paired subset. The
extra token load is overwhelmingly cache-read context rather than generated output:
Luna actually produced 34.7% fewer output tokens in hashline mode in the full sample.

One successful hashline outlier is also worth retaining. p80077
`13-repeated-identical-lines` eventually produced the exact file but required seven
valid edit calls with intervening re-reads, repeatedly moving `"ready"` between nearby
identical `"pending"` entries before settling on the third betaQueue element. The
protocol prevented anchor ambiguity or silent misapplication, but did not prevent the
model from cognitively oscillating over ordinal position. This is model behavior rather
than an edit-engine failure, and it explains six of hashline's extra completed calls.

Overall, Luna reinforces the same correctness pattern seen in the earlier models:
explicit hashline deletion is more reliable on exact-whitespace oracles, while the
stricter protocol carries model-dependent context/cache overhead. Unlike Muse's malformed
completed calls, Luna's completed hashline calls were perfectly schema-compliant; its
one failure happened before SmartEdit execution as a pathological unfinished tool stream.
