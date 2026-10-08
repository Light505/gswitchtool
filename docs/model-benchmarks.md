# Model benchmarks and prices

Capability and cost of every model and reasoning effort the router and Invoke
Mode can use. The router's cost ladders
([`router-guide.md`](./router-guide.md#cost-ladders)) are built from these
tables. Data as of 2026-10-08; recheck when models or prices change and update
this file, the router guide and the route skill together.

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
| Haiku low | 29 | 13% | 49% | $0.02 | 17k | 62s |
| Haiku medium | 34 | 15% | 49% | $0.05 | 33k | 145s |
| Haiku high | 38 | 22% | 49% | $0.08 | 55k | 235s |
| Haiku xhigh | 41 | 29% | 52% | $0.12 | 89k | 291s |
| Haiku max | 43 | 33% | 55% | $0.21 | 162k | 427s |
| Sonnet low | 36 | 21% | 49% | $0.35 | 14k | 90s |
| Sonnet medium | 41 | 30% | 53% | $0.48 | 21k | 137s |
| Sonnet high | 47 | 44% | 54% | $0.88 | 37k | 235s |
| Sonnet xhigh | 52 | 57% | 57% | $2.01 | 75k | 456s |
| Sonnet max | 56 | 64% | 61% | $5.46 | 197k | 982s |
| Opus low | 42 | 31% | 59% | $0.55 | 10k | 85s |
| Opus medium | 51 | 53% | 59% | $1.34 | 26k | 209s |
| Opus high | 54 | 57% | 60% | $1.82 | 36k | 297s |
| Opus xhigh | 56 | 60% | 65% | $3.46 | 66k | 516s |
| Opus max | 58 | 60% | 67% | $5.98 | 119k | 784s |
| Luna low | 22 | 0% | 47% | $0.0045 | 2k | 17s |
| Luna medium | 30 | 3% | 51% | $0.02 | 11k | 172s |
| Luna high | 33 | 5% | 50% | $0.03 | 20k | 242s |
| Luna xhigh | 35 | 8% | 52% | $0.04 | 27k | 390s |
| Luna max | 38 | 13% | 55% | $0.07 | 50k | n/a |
| Sol low | 42 | 31% | 53% | $0.13 | 4k | 79s |
| Sol medium | 48 | 48% | 53% | $0.21 | 8k | 163s |
| Sol high | 50 | 52% | 56% | $0.32 | 13k | 254s |
| Sol xhigh | 51 | 54% | 56% | $0.39 | 18k | 330s |
| Sol max | 52 | 56% | 54% | $0.72 | 38k | 685s |

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
- Sol high and Sol max are beaten by Sol medium and Sol xhigh in CAI.
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

`scripts/router-ladder-calc.mjs` computes, for every possible start, the
expected cost and time to solve a task: each attempt's cost plus $0.30 of
orchestrator and review overhead, times the chance the task gets that far.
Failures are 80% driven by difficulty (a task one worker fails is likely hard
for the next) and 20% luck. Easier difficulties fail less often than the CAI's
hard tasks: moderate ×0.5, small ×0.25, trivial ×0.1. The default is the
cheapest start, or the fastest start within 10% of it. Expected cost per task:

| Difficulty | `claude` | `mixed` | `codex` |
| --- | --- | --- | --- |
| Trivial | Haiku low, $0.82 | Haiku low, $0.80 | Luna max, $0.56 |
| Small | Haiku low, $1.48 | Haiku low, $1.40 | Luna max, $0.68 |
| Moderate | Haiku medium, $3.05 (cheapest Haiku low $2.83) | Haiku low, $2.56 | Luna max, $0.88 |
| Hard | Sonnet low, $6.92 (cheapest Haiku low $6.71) | Sol low, $5.86 (cheapest Luna max $5.60) | Sol low, $1.38 (cheapest Luna max $1.27) |

Expected costs in `claude` and `mixed` include the chance of reaching Sonnet
max ($14.19), which dominates hard tasks. Starting moderate `claude` work at
Opus medium costs $4.49 here and only becomes cheapest with about $3 of
overhead per attempt. High-risk work is not in the calculation: it starts
stronger (`claude` Opus medium, otherwise Sol xhigh) because a wrong change
that passes the tests costs more there. The defaults hold for overhead between
$0.25 and $0.50 and correlation between 0.5 and 0.8.
