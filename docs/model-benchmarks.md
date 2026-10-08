# Model benchmarks and prices

Capability and cost of every model and reasoning effort the router and Invoke
Mode can use. The router's time-and-cost escalation ladders
([`router-guide.md`](./router-guide.md#escalation-ladders)) are built from these
tables. Data as of 2026-10-08; recheck when models or prices change and update
this file, the router guide and the route skill together. The full AA release
comparison was checked the same day; it matches the Intelligence Index numbers
used here.

## Sources and how to read them

All capability numbers come from one group, Artificial Analysis (AA), so every
model is measured the same way. AA publishes two kinds of runs:

- **Coding Agent Index** (CAI): the model inside its real coding agent (Claude
  Code or Codex) on DeepSWE v1.1, Terminal-Bench 4.0 and SWE-Atlas-QnA, three
  attempts per task. Cost per task is the full agent session at API list
  prices (input, cached input, cache writes, output). This matches how router
  workers and Codex actually run, so it decides wherever it has a number. The
  public table covers only some efforts:
  [Claude Code vs Codex](https://artificialanalysis.ai/agents/coding-agents/comparisons/claude-code-vs-codex).
- **Intelligence Index runs** (II): every model at every effort in AA's own
  harness on ten evaluations. Two columns matter here: the overall Intelligence
  Index and its Terminal-Bench 4.0 part (agentic coding in a terminal). Cost per
  task is the average across those evaluations, not a coding session. Complete
  for all 25 combinations:
  [model comparison](https://artificialanalysis.ai/models/comparisons).

Other sources checked and not used: Vals.ai archived its SWE-bench board on
2026-09-01 and runs the Vals Index only at max effort; Scale's SWE-bench Pro
board and Epoch AI have no runs of these models yet; vendor charts (Anthropic,
OpenAI) give few exact numbers per effort and cannot be compared across
vendors.

## Prices (USD per million tokens)

| Model | Input | Cache write (5 min) | Cached input | Output | Source |
| --- | --- | --- | --- | --- | --- |
| Claude Haiku 5.5, prompt ≤ 100K tokens | 0.10 | 0.125 | 0.01 | 0.50 | [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |
| Claude Haiku 5.5, prompt > 100K tokens | 0.50 | 0.625 | 0.05 | 2.50 | Anthropic |
| Claude Sonnet 5.5 | 2.00 | 2.50 | 0.10 | 10.00 | Anthropic |
| Claude Opus 5.5 | 4.00 | 5.00 | 0.20 | 20.00 | Anthropic |
| GPT-6.1 Sol, prompt ≤ 272K tokens | 2.00 | 2.50 | 0.10 | 10.00 | [OpenAI](https://developers.openai.com/api/docs/pricing) |
| GPT-6 Luna, prompt ≤ 272K tokens | 0.10 | 0.125 | 0.01 | 0.50 | OpenAI |

Agent sessions often pass 100K tokens of context, where Haiku costs 5× more.
That is why Haiku is cheap in the II runs but not in Claude Code (CAI).

## Coding Agent Index (real agent harness)

| Worker | Index | DeepSWE | Terminal-Bench | SWE-Atlas-QnA | Cost/task | Time/task | Tokens/task |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku low | 28 | 45% | 6% | 33% | $0.14 | 11.6m | 2.4M |
| Haiku medium | 34 | 47% | 12% | 42% | $0.23 | 14.0m | 3.5M |
| Haiku high | 35 | 46% | 13% | 46% | $0.36 | 18.4m | 5.1M |
| Haiku xhigh | 41 | 49% | 24% | 52% | $0.61 | 25.9m | 7.1M |
| Haiku max | 36 | 46% | 30% | 34% | $2.58 | 1.5h | 13.8M |
| Sonnet low | 42 | 62% | 25% | 39% | $0.48 | 6.3m | 0.98M |
| Sonnet medium | 46 | 65% | 27% | 45% | $0.62 | 8.5m | 1.3M |
| Sonnet high | 55 | 67% | 42% | 56% | $1.24 | 12.3m | 2.7M |
| Sonnet xhigh | 63 | 68% | 58% | 62% | $3.33 | 27.0m | 7.1M |
| Sonnet max | 68 | 72% | 66% | 67% | $14.19 | 1.5h | 27.7M |
| Opus low…xhigh | not published | | | | | | |
| Opus max | 66 | 68% | 63% | 66% | $13.04 | 1.1h | 15.6M |
| Luna low…xhigh | not published | | | | | | |
| Luna max | 41 | 64% | 15% | 44% | $0.18 | 21.4m | 10.2M |
| Sol low | 57 | 68% | 49% | 55% | $0.50 | 8.6m | 1.7M |
| Sol medium | 61 | 72% | 52% | 61% | $0.70 | 10.9m | 2.3M |
| Sol high | 60 | 71% | 50% | 60% | $0.89 | 13.3m | 2.8M |
| Sol xhigh | 63 | 73% | 55% | 61% | $1.04 | 15.5m | 3.2M |
| Sol max | 60 | 70% | 53% | 58% | $1.55 | 24.4m | 4.0M |

## Intelligence Index runs (all efforts)

| Worker | Intelligence Index | Terminal-Bench 4.0 | SciCode | Cost/task | Output tokens/task | Time/task |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku low | 29 | 13% | 49% | $0.02 | 17k | 60s |
| Haiku medium | 34 | 15% | 49% | $0.05 | 33k | 126s |
| Haiku high | 38 | 22% | 49% | $0.08 | 55k | 189s |
| Haiku xhigh | 41 | 29% | 52% | $0.12 | 89k | 286s |
| Haiku max | 43 | 33% | 55% | $0.21 | 162k | 420s |
| Sonnet low | 36 | 21% | 49% | $0.35 | 14k | 88s |
| Sonnet medium | 41 | 30% | 53% | $0.48 | 21k | 126s |
| Sonnet high | 47 | 44% | 54% | $0.88 | 37k | 217s |
| Sonnet xhigh | 52 | 57% | 57% | $2.01 | 75k | 431s |
| Sonnet max | 56 | 64% | 61% | $5.46 | 197k | 954s |
| Opus low | 42 | 31% | 59% | $0.55 | 10k | 82s |
| Opus medium | 51 | 53% | 59% | $1.34 | 26k | 205s |
| Opus high | 54 | 57% | 60% | $1.82 | 36k | 286s |
| Opus xhigh | 56 | 60% | 65% | $3.46 | 66k | 513s |
| Opus max | 58 | 60% | 67% | $5.98 | 119k | 783s |
| Luna low | 22 | 0% | 47% | $0.0045 | 2k | 17s |
| Luna medium | 30 | 3% | 51% | $0.02 | 11k | n/a |
| Luna high | 33 | 5% | 50% | $0.03 | 20k | 173s |
| Luna xhigh | 35 | 8% | 52% | $0.04 | 27k | 242s |
| Luna max | 38 | 13% | 55% | $0.07 | 50k | 390s |
| Sol low | 42 | 31% | 53% | $0.13 | 4k | 79s |
| Sol medium | 48 | 48% | 53% | $0.21 | 8k | 158s |
| Sol high | 50 | 52% | 56% | $0.32 | 13k | 261s |
| Sol xhigh | 51 | 54% | 56% | $0.39 | 18k | 330s |
| Sol max | 52 | 56% | 54% | $0.72 | 38k | 684s |

## Release comparison (all Intelligence Index evaluations)

AA's [release comparison](https://artificialanalysis.ai/models/releases/comparisons?compare=claude-opus-5-5%2Cclaude-haiku-5-5%2Cclaude-sonnet-5-5%2Cgpt-6-1-sol%2Cgpt-6-luna)
shows the same runs with all ten evaluations, the capability indexes, speed and
latency (retrieved 2026-10-08; the whole table, unchanged, is in
[`data/aa-release-comparison-2026-10-08.tsv`](./data/aa-release-comparison-2026-10-08.tsv)).
Intelligence Index, Terminal-Bench 4.0 and cost per task equal the table above.
Its input, output, cache hit and cache write prices equal the Prices table.
"--" means AA shows no value.

Scores:

| Worker | Intelligence Index | Finance & Accounting | Strategy & Ops | Legal | Healthcare & Medical | Engineering | Economics | AA-Briefcase | GDPval-AA | AutomationBench-AA | Terminal-Bench 4.0 | SciCode | Humanity's Last Exam | GDP.pdf | CritPt | AA-Omniscience | AA-LCR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku low | 29 | 29 | 28 | 31 | -- | 31 | 37 | 1112 | 1125 | 22.9% | 12.6% | 49.2% | 27.0% | 11.2% | 9.1% | 3 | 72.0% |
| Haiku medium | 34 | 35 | 34 | 36 | -- | 35 | 43 | 1372 | 1277 | 28.6% | 15.2% | 49.0% | 33.8% | 15.2% | 12.9% | 4 | 77.3% |
| Haiku high | 38 | 38 | 37 | 38 | -- | 39 | 46 | 1443 | 1420 | 33.7% | 21.7% | 48.7% | 37.3% | 17.2% | 18.6% | 6 | 77.3% |
| Haiku xhigh | 41 | 41 | 39 | 40 | -- | 43 | 49 | 1533 | 1511 | 36.0% | 29.3% | 51.7% | 42.7% | 18.2% | 22.6% | 6 | 78.3% |
| Haiku max | 43 | 44 | 40 | 42 | -- | 45 | 51 | 1578 | 1620 | 35.4% | 32.8% | 55.0% | 44.4% | 20.8% | 18.9% | 11 | 82.7% |
| Sonnet low | 36 | 38 | 41 | 41 | -- | 38 | 44 | 1272 | 1179 | 49.4% | 20.7% | 49.1% | 36.2% | 16.0% | 11.4% | 19 | 76.0% |
| Sonnet medium | 41 | 41 | 45 | 44 | -- | 42 | 47 | 1442 | 1324 | 54.9% | 29.8% | 52.9% | 39.8% | 20.2% | 16.9% | 20 | 76.3% |
| Sonnet high | 47 | 47 | 52 | 49 | -- | 48 | 52 | 1639 | 1551 | 59.4% | 43.9% | 53.7% | 45.8% | 25.2% | 24.6% | 21 | 78.0% |
| Sonnet xhigh | 52 | 52 | 56 | 52 | -- | 54 | 56 | 1751 | 1731 | 65.5% | 57.1% | 57.3% | 50.0% | 24.6% | 31.1% | 24 | 79.7% |
| Sonnet max | 56 | 57 | 60 | 56 | 58 | 58 | 61 | 1823 | 1839 | 71.8% | 63.6% | 61.0% | 55.0% | 25.8% | 31.4% | 32 | 82.7% |
| Opus low | 42 | 46 | 48 | 52 | -- | 45 | 53 | 1280 | 1235 | 52.9% | 31.3% | 58.6% | 48.3% | 25.6% | 17.7% | 39 | 80.7% |
| Opus medium | 51 | 54 | 57 | 57 | -- | 54 | 60 | 1628 | 1586 | 61.2% | 52.5% | 59.3% | 54.7% | 25.6% | 27.7% | 40 | 84.3% |
| Opus high | 54 | 56 | 59 | 59 | -- | 56 | 61 | 1689 | 1707 | 63.2% | 56.6% | 60.4% | 55.6% | 28.8% | 30.9% | 41 | 82.7% |
| Opus xhigh | 56 | 58 | 62 | 61 | -- | 59 | 63 | 1768 | 1837 | 65.0% | 59.6% | 65.0% | 57.5% | 26.6% | 31.7% | 43 | 84.7% |
| Opus max | 58 | 61 | 64 | 63 | 61 | 60 | 66 | 1807 | 1866 | 69.5% | 59.6% | 66.9% | 61.4% | 26.2% | 31.7% | 46 | 84.7% |
| Luna non-reasoning | 18 | 20 | 20 | 19 | -- | 21 | 24 | 903 | 1049 | 9.1% | 1.5% | 43.1% | 8.6% | 5.8% | 1.1% | −22 | 39.7% |
| Luna low | 22 | 24 | 23 | 25 | -- | 23 | 30 | 741 | 1036 | 12.0% | 0.0% | 46.9% | 20.3% | 9.0% | 2.6% | −9 | 74.0% |
| Luna medium | 30 | 33 | 37 | 33 | -- | 29 | 37 | 1099 | 1262 | 40.5% | 2.5% | 50.9% | 28.3% | 13.8% | 10.6% | −5 | 78.3% |
| Luna high | 33 | 36 | 41 | 35 | -- | 32 | 40 | 1186 | 1344 | 47.8% | 4.5% | 50.3% | 32.9% | 18.2% | 15.4% | −6 | 79.3% |
| Luna xhigh | 35 | 37 | 43 | 37 | -- | 34 | 42 | 1237 | 1364 | 47.8% | 8.1% | 51.7% | 34.3% | 18.6% | 17.4% | −2 | 80.0% |
| Luna max | 38 | 40 | 46 | 40 | 37 | 37 | 45 | 1336 | 1432 | 53.2% | 12.6% | 54.6% | 38.5% | 22.8% | 19.4% | 1 | 83.3% |
| Sol low | 42 | 45 | 46 | 50 | -- | 44 | 52 | 1118 | 1297 | 52.6% | 30.8% | 53.2% | 47.4% | 27.0% | 24.9% | 38 | 84.0% |
| Sol medium | 48 | 50 | 53 | 54 | -- | 50 | 56 | 1365 | 1433 | 62.6% | 48.0% | 53.2% | 49.9% | 30.0% | 27.7% | 40 | 83.3% |
| Sol high | 50 | 53 | 55 | 56 | -- | 52 | 58 | 1471 | 1486 | 64.5% | 51.5% | 55.8% | 51.4% | 32.0% | 30.0% | 41 | 82.3% |
| Sol xhigh | 51 | 53 | 56 | 57 | -- | 53 | 58 | 1507 | 1510 | 66.6% | 54.0% | 55.7% | 52.6% | 31.8% | 31.7% | 41 | 79.7% |
| Sol max | 52 | 54 | 57 | 58 | 51 | 54 | 59 | 1564 | 1575 | 64.9% | 56.1% | 54.2% | 52.9% | 31.0% | 31.7% | 42 | 83.0% |

Cost and speed:

| Worker | Cost/task | Output tokens/s | First token (s) | First answer token (s) | End-to-end response (s) | Time/task (s) |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku low | $0.02 | 185 | 12.79 | 12.79 | 15.49 | 60.01 |
| Haiku medium | $0.05 | 155 | 13.40 | 13.40 | 16.62 | 125.75 |
| Haiku high | $0.08 | 178 | 26.69 | 26.69 | 29.49 | 188.98 |
| Haiku xhigh | $0.12 | 193 | 78.84 | 78.84 | 81.43 | 286.30 |
| Haiku max | $0.21 | 244 | 341.02 | 341.02 | 343.06 | 420.16 |
| Sonnet low | $0.35 | 103 | 1.11 | 1.11 | 5.97 | 88.03 |
| Sonnet medium | $0.48 | 102 | 2.05 | 2.05 | 6.96 | 126.43 |
| Sonnet high | $0.88 | 104 | 12.70 | 12.70 | 17.53 | 217.35 |
| Sonnet xhigh | $2.01 | 107 | 34.06 | 34.06 | 38.72 | 430.69 |
| Sonnet max | $5.46 | 131 | 473.93 | 473.93 | 477.76 | 953.87 |
| Opus low | $0.55 | 79 | 8.29 | 8.29 | 14.62 | 81.80 |
| Opus medium | $1.34 | 76 | 21.32 | 21.32 | 27.86 | 204.82 |
| Opus high | $1.82 | 76 | 37.62 | 37.62 | 44.16 | 286.31 |
| Opus xhigh | $3.46 | 80 | 131.18 | 131.18 | 137.44 | 513.29 |
| Opus max | $5.98 | 96 | 723.65 | 723.65 | 728.88 | 783.19 |
| Luna non-reasoning | $0.01 | 119 | 0.76 | 0.76 | 4.96 | 31.49 |
| Luna low | $0.0045 | 125 | 3.23 | 3.23 | 7.23 | 16.89 |
| Luna medium | $0.02 | -- | -- | -- | -- | -- |
| Luna high | $0.03 | 112 | 19.29 | 19.29 | 23.75 | 172.80 |
| Luna xhigh | $0.04 | 115 | 27.33 | 27.33 | 31.66 | 241.52 |
| Luna max | $0.07 | 128 | 108.60 | 108.60 | 112.50 | 389.64 |
| Sol low | $0.13 | 49 | 3.11 | 3.11 | 13.35 | 79.48 |
| Sol medium | $0.21 | 50 | 6.43 | 6.43 | 16.43 | 157.99 |
| Sol high | $0.32 | 50 | 60.71 | 60.71 | 70.66 | 261.03 |
| Sol xhigh | $0.39 | 53 | 148.30 | 148.30 | 157.67 | 329.86 |
| Sol max | $0.72 | 56 | 331.97 | 331.97 | 340.97 | 684.27 |

## Best value per cost (Pareto frontier)

A worker is on the frontier when no other worker scores at least as high for
less. Claude workers only:

| Measure | Frontier, cheapest first |
| --- | --- |
| CAI index | Haiku low → Haiku medium → (Haiku high) → Sonnet low → Sonnet medium → Sonnet high → Sonnet xhigh → Sonnet max (Opus below max not measured) |
| II Terminal-Bench 4.0 | Haiku low → medium → high → xhigh → max → Sonnet high → Opus medium → Opus high → Opus xhigh → Sonnet max |
| II overall | Haiku low → medium → high → xhigh → max → Sonnet high → Opus medium → Opus high → Opus xhigh → Opus max |

What the measures agree on:

- Sonnet high is on every frontier. Opus medium, high and xhigh are on both II
  frontiers; Opus high beats Sonnet xhigh on both (equal or higher score for
  about 10% less), and Opus max is beaten by Sonnet max in CAI and II
  Terminal-Bench.
- Haiku above medium is cheap in single runs but expensive as an agent: in
  Claude Code, Haiku xhigh and max cost more than Sonnet low and score lower.
- Sol high and Sol max are beaten by Sol medium in CAI (Sol xhigh is not
  allowed by the owner's GSwitch setup).
- Luna is weak at agentic terminal work at every effort (Terminal-Bench 0–15%)
  but strong on DeepSWE (64% at max). Below max it was only measured in II.

Limits: differences of one or two points are noise; Opus below max and Luna
below max have no CAI numbers, so their ladder places rest on the two II
measures; plan usage limits count usage in their own way, which API cost only
approximates.

## Opus estimates for agent sessions

The Coding Agent Index has Opus only at max. For Opus medium, high and xhigh,
the router uses estimates:

- Score: from each effort's II Terminal-Bench 4.0 result, read against the
  Sonnet efforts whose II Terminal-Bench and CAI index are both known. Opus
  medium ~60, high ~63, xhigh ~65.
- Cost: II cost per task × Sonnet's CAI/II cost ratio at the same effort
  (1.29 to 2.60) × 0.84 (Opus max's ratio is 0.84 of Sonnet max's, because Opus
  uses fewer tokens per task). Opus medium ~$1.45, high ~$2.16, xhigh ~$4.82.

Uncertainty is about ±30%. Replace them when AA publishes CAI numbers for Opus
below max, or from the router's own results.

## Default start per difficulty

`scripts/router-ladder-calc.mjs` scores each start by the objective per task:
expected cost plus $0.05 per expected minute (about $3 per hour of waiting).
Each attempt costs its worker's price plus $0.30 of orchestrator and review
overhead, and takes its worker's minutes (Coding Agent Index time per task)
plus 3 minutes of orchestrator and review time. A ladder step must raise the
score. The chance a task reaches each attempt: failures are 80% driven by
difficulty (a task one worker fails is likely hard for the next) and 20%
luck. Easier difficulties fail less often than the CAI's hard tasks: moderate
×0.5, small ×0.25, trivial ×0.1. The calculator searches every start and path
(its "Search" section) and evaluates the approved starts and ladders as fixed
paths (its "Chosen defaults" section). The owner approved the defaults below.
Expected cost and minutes per task, including escalations; "previous" is the
cost-only default with Sol xhigh counted as skipped, as it ran:

`claude`:

| Difficulty | Default start | Expected cost | Expected minutes | Previous |
| --- | --- | --- | --- | --- |
| Trivial | Haiku low | $0.82 | 19 | same |
| Small | Haiku low | $1.48 | 26 | same |
| Moderate | Haiku low | $2.83 | 39 | Haiku medium, $3.05, 38 min |
| Hard | Sonnet low | $6.95 | 57 | same |
| High-risk | Opus medium | not in calculation | | same |

`mixed`:

| Difficulty | Default start | Expected cost | Expected minutes | Previous |
| --- | --- | --- | --- | --- |
| Trivial | Haiku low | $0.82 | 18 | Haiku low, $0.84, 19 min |
| Small | Haiku low | $1.46 | 24 | Haiku low, $1.50, 27 min |
| Moderate | Haiku low | $2.72 | 35 | Haiku low, $2.76, 40 min |
| Hard | Sol low | $6.25 | 51 | Sol low, $6.24, 50 min |
| High-risk | Sol high | not in calculation | | Sol xhigh |

`codex`:

| Difficulty | Default start | Expected cost | Expected minutes | Previous |
| --- | --- | --- | --- | --- |
| Trivial | Sol low | $0.84 | 12 | Luna max, $0.48, 24 min |
| Small | Sol low | $0.91 | 13 | Luna max, $0.48, 24 min |
| Moderate | Sol medium | $1.00 | 14 | Luna max, $0.48, 24 min |
| Hard | Sol medium | $1.00 | 14 | Sol low, $0.80, 12 min |
| High-risk | Sol high | not in calculation | | Sol xhigh |

The codex "previous" looked cheap only because Sol xhigh was skipped: with no
escalation, Luna max or Sol low stopped after one failure (unsolved share
29.5% for moderate, now 19.5%). Its unsolved share is the chance the task is
still failing after the last rung.

Sensitivity: with 6 minutes of overhead time the starts are the same. At $0.10
per minute, trivial-to-moderate starts move to Sonnet low in `claude` and
`mixed`; the owner chose to keep $0.05. At $0 (cost only), codex would start at
Luna max and `mixed` hard at Haiku low. With overhead between $0.25 and $0.50
and correlation between 0.5 and 0.8 the starts hold, except `mixed` moderate
(Sonnet low at $0.50 overhead) and `mixed` hard (Sonnet low at correlation 0.5).

Timing evidence: the router results log had one timed worker attempt (Haiku
low, moderate, 2.3 minutes against 11.6 in the benchmark), so benchmark minutes
are for hard tasks and only the ratios between workers are used. GSwitch's
activity log had 37 Codex runs with times (median Luna high 17 minutes, n=8;
Luna xhigh 6 minutes, n=7; Sol high 15 minutes, n=11), but no difficulty or
outcome, so it cannot compare models. The speed weighting rests on the
Artificial Analysis Coding Agent Index time per task; replace it when the
router's own results reach 10 per worker and difficulty.

Sol xhigh is not allowed by the owner's GSwitch setup, so it is not a rung.

Expected costs in `claude` and `mixed` include the chance of reaching Sonnet
max ($14.19), which dominates hard tasks. High-risk work is not in the
calculation: it starts stronger (`claude` Opus medium, `mixed` and `codex` Sol
high) because a wrong change that passes the tests costs more there.
