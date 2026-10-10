import { describe, expect, it } from "vitest";

import { describeSetup } from "./setupSummary";
import type { AccountView, ClaudeSetup, InvokeSettings } from "./types";

function settings(setup: ClaudeSetup["setup"], router: Partial<ClaudeSetup["router"]> = {}): InvokeSettings {
  return {
    invoke_mode: setup !== "claude-only",
    allowed_invocation_profiles: [],
    claude_setup: {
      setup,
      codexSpeed: { mode: "normal", fastMinRemaining: 20 },
      router: {
        mode: "mixed",
        prefer: "codex",
        sampling: "on",
        claudeAllowed: { haiku: [], sonnet: [], opus: [] },
        claudeOnlyReview: "on",
        ...router,
      },
    },
  };
}

const account = (id: string, invoke_allowed: boolean, kind: AccountView["kind"] = "chat_gpt"): AccountView =>
  ({ id, label: id, kind, active: false, invoke_allowed });

// Two of three ChatGPT accounts allowed; the API-key account is never counted.
const accounts = [account("a", true), account("b", true), account("c", false), account("key", true, "api_key")];
const accountPart = "Codex may use 2 of your 3 accounts and switches when one runs out.";
const plans = "Claude Code plans each task and checks the result.";

describe("describeSetup", () => {
  it("says nothing before the settings are read", () => {
    expect(describeSetup(null, accounts)).toBeNull();
  });

  it("describes Claude only", () => {
    expect(describeSetup(settings("claude-only"), accounts)).toBe("Claude Code does all the work. Codex is not used.");
  });

  it("describes Claude + Codex with the allowed accounts", () => {
    expect(describeSetup(settings("claude-codex"), accounts)).toBe(
      `Claude Code does the work and hands suitable coding tasks to Codex, and has Codex review bigger changes. ${accountPart}`,
    );
  });

  it.each([
    ["codex", "Codex"],
    ["claude", "A Claude model"],
    ["price", "The cheapest suitable model"],
  ] as const)("describes the mixed router preferring %s", (prefer, first) => {
    expect(describeSetup(settings("router", { mode: "mixed", prefer }), accounts)).toBe(
      `${plans} ${first} writes the code first; if it fails, a stronger model takes over. ${accountPart}`,
    );
  });

  it("describes the Codex-only router", () => {
    expect(describeSetup(settings("router", { mode: "codex" }), accounts)).toBe(
      `${plans} Codex writes all the code; if it fails, a stronger Codex model takes over. ${accountPart}`,
    );
  });

  it("describes the Claude-only router without an account part", () => {
    expect(describeSetup(settings("router", { mode: "claude" }), accounts)).toBe(
      `${plans} Claude models write the code; if one fails, a stronger one takes over. Codex is not used for writing.`,
    );
  });

  it("asks for an allowed account when Codex is used and none is allowed", () => {
    const none = [account("a", false), account("b", false)];
    const missing = "No account is allowed for Codex yet — allow one in Accounts.";
    expect(describeSetup(settings("claude-codex"), none)).toBe(
      `Claude Code does the work and hands suitable coding tasks to Codex, and has Codex review bigger changes. ${missing}`,
    );
    expect(describeSetup(settings("router", { mode: "codex" }), [])).toBe(
      `${plans} Codex writes all the code; if it fails, a stronger Codex model takes over. ${missing}`,
    );
  });
});
