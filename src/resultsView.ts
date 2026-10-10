import type { ResultsRow } from "./types";

/** First-try results below this many tasks are too few to judge. */
export const MIN_FIRST_TRIES = 10;

export interface ResultsModelRow {
  key: string;
  name: string;
  attempts: number;
  firstTries: number;
  firstTryPasses: number;
  samples: number;
  medianMs: number | null;
  medianUsd: number | null;
}

const CODEX_NAMES: Record<string, string> = { "gpt-6.1-sol": "Codex Sol 6.1", "gpt-6-luna": "Codex Luna 6" };
const CLAUDE_NAMES: Record<string, string> = { haiku: "Claude Haiku", sonnet: "Claude Sonnet", opus: "Claude Opus" };

/** Plain-words model name with its effort, e.g. "Codex Sol 6.1, medium". */
export function modelDisplayName(family: "claude" | "codex", model: string, effort: string) {
  let name = model;
  if (family === "codex") {
    name = CODEX_NAMES[model] ?? model;
  } else {
    const lower = model.toLowerCase();
    const known = Object.keys(CLAUDE_NAMES).find((key) => lower.includes(key));
    name = known ? CLAUDE_NAMES[known] : model;
  }
  return effort ? `${name}, ${effort}` : name;
}

/**
 * One row per model and effort, busiest first. Rows of several difficulties are
 * summed for counts; the typical time and cost come from the difficulty row with
 * the most attempts (simple, and a median of medians would not be more exact).
 */
export function aggregateResults(rows: ResultsRow[], difficulty: string): ResultsModelRow[] {
  const groups = new Map<string, { row: ResultsModelRow; best: ResultsRow }>();
  for (const row of rows) {
    if (difficulty !== "all" && row.difficulty !== difficulty) continue;
    const key = `${row.family}\0${row.worker}\0${row.model}\0${row.effort}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        best: row,
        row: {
          key, name: modelDisplayName(row.family, row.model, row.effort), attempts: row.attempts,
          firstTries: row.firstTries, firstTryPasses: row.firstTryPasses, samples: row.samples,
          medianMs: row.medianMs, medianUsd: row.medianUsd,
        },
      });
      continue;
    }
    group.row.attempts += row.attempts;
    group.row.firstTries += row.firstTries;
    group.row.firstTryPasses += row.firstTryPasses;
    group.row.samples += row.samples;
    if (row.attempts > group.best.attempts) {
      group.best = row;
      group.row.medianMs = row.medianMs;
      group.row.medianUsd = row.medianUsd;
    }
  }
  return [...groups.values()].map((group) => group.row).sort((a, b) => b.attempts - a.attempts);
}

/** Whole percent of first tries that passed, or null when there are too few to judge. */
export function firstTryPercent(row: Pick<ResultsModelRow, "firstTries" | "firstTryPasses">) {
  if (row.firstTries < MIN_FIRST_TRIES) return null;
  return Math.round((row.firstTryPasses / row.firstTries) * 100);
}

export function formatDuration(ms: number | null) {
  if (ms == null) return "–";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

export function formatCost(usd: number | null) {
  return usd == null ? "–" : `$${usd.toFixed(2)}`;
}
