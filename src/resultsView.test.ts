import { describe, expect, it } from "vitest";

import { aggregateResults, firstTryPercent, formatCost, formatDuration, modelDisplayName } from "./resultsView";
import type { ResultsRow } from "./types";

function row(overrides: Partial<ResultsRow>): ResultsRow {
  return {
    worker: "w", family: "codex", model: "gpt-6.1-sol", effort: "medium", difficulty: "small",
    attempts: 1, passes: 1, firstTries: 1, firstTryPasses: 1, samples: 0, medianMs: 60000, medianTokens: 1, medianUsd: 0.5,
    ...overrides,
  };
}

describe("results view", () => {
  it("names models in plain words", () => {
    expect(modelDisplayName("codex", "gpt-6.1-sol", "medium")).toBe("Codex Sol 6.1, medium");
    expect(modelDisplayName("codex", "gpt-6-luna", "low")).toBe("Codex Luna 6, low");
    expect(modelDisplayName("codex", "gpt-9", "high")).toBe("gpt-9, high");
    expect(modelDisplayName("claude", "claude-haiku-4-5", "low")).toBe("Claude Haiku, low");
    expect(modelDisplayName("claude", "sonnet", "high")).toBe("Claude Sonnet, high");
    expect(modelDisplayName("claude", "claude-opus-5", "xhigh")).toBe("Claude Opus, xhigh");
  });

  it("filters by difficulty and sorts by tasks", () => {
    const rows = [
      row({ difficulty: "small", attempts: 2 }),
      row({ model: "gpt-6-luna", effort: "low", difficulty: "small", attempts: 5 }),
      row({ model: "gpt-6-luna", effort: "low", difficulty: "hard", attempts: 9 }),
    ];
    const small = aggregateResults(rows, "small");
    expect(small.map((item) => item.name)).toEqual(["Codex Luna 6, low", "Codex Sol 6.1, medium"]);
    expect(aggregateResults(rows, "trivial")).toEqual([]);
  });

  it("sums counts and takes typical time and cost from the busiest difficulty", () => {
    const rows = [
      row({ difficulty: "small", attempts: 3, firstTries: 3, firstTryPasses: 2, samples: 1, medianMs: 1000, medianUsd: 0.1 }),
      row({ difficulty: "hard", attempts: 7, firstTries: 6, firstTryPasses: 5, medianMs: 120000, medianUsd: 2 }),
    ];
    const [all] = aggregateResults(rows, "all");
    expect(all).toMatchObject({ attempts: 10, firstTries: 9, firstTryPasses: 7, samples: 1, medianMs: 120000, medianUsd: 2 });
  });

  it("shows a percent only with enough first tries", () => {
    expect(firstTryPercent({ firstTries: 9, firstTryPasses: 9 })).toBeNull();
    expect(firstTryPercent({ firstTries: 10, firstTryPasses: 7 })).toBe(70);
  });

  it("formats time and cost", () => {
    expect(formatDuration(null)).toBe("–");
    expect(formatDuration(42000)).toBe("42 s");
    expect(formatDuration(180000)).toBe("3 min");
    expect(formatCost(null)).toBe("–");
    expect(formatCost(0.456)).toBe("$0.46");
  });
});
