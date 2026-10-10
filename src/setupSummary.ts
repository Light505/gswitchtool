// Added by Light505 for gswitchtool (2026): the Home page's one-sentence
// summary of how Claude Code and Codex share the work under the saved settings.

import { createTranslator, type TranslationKey } from "./i18n";
import type { AccountView, ClaudeSetup, InvokeSettings } from "./types";

export interface TypicalTaskStep { label: TranslationKey; text: TranslationKey }
export interface TypicalTask { steps: TypicalTaskStep[]; note: TranslationKey | null }

/** The steps a typical task goes through under the (possibly unsaved) setup; i18n keys only. */
export function describeTypicalTask(draft: ClaudeSetup): TypicalTask {
  const step = (name: string, text = name): TypicalTaskStep => ({
    label: `typical.label.${name}` as TranslationKey,
    text: `typical.text.${text}` as TranslationKey,
  });
  if (draft.setup === "claude-only") {
    return { steps: [step("plan", "plan.claudeOnly"), step("write", "write.claudeOnly"), step("check", "check.claudeOnly")], note: null };
  }
  if (draft.setup === "claude-codex") {
    return { steps: [step("plan", "plan.claudeCodex"), step("write", "write.claudeCodex"), step("check", "check.claudeCodex")], note: null };
  }
  const { mode, prefer, claudeOnlyReview, sampling } = draft.router;
  const pick = mode === "codex" ? "pick.codex"
    : mode === "claude" ? "pick.claudeOnly"
    : `pick.mixed.${prefer}`;
  const review = mode === "claude" && claudeOnlyReview === "on";
  return {
    steps: [
      step("rate"),
      step("pick", pick),
      step("check", review ? "check.routerReview" : "check.router"),
      step("fail"),
    ],
    note: sampling === "on" ? "typical.sampling" : null,
  };
}

const t = createTranslator();

/** Describes the saved setup in plain words; null until the settings are read. */
export function describeSetup(settings: InvokeSettings | null, accounts: AccountView[]): string | null {
  if (!settings) return null;
  const { setup, router } = settings.claude_setup;
  if (setup === "claude-only") return t("setup.claudeOnly");

  const chatGpt = accounts.filter((account) => account.kind === "chat_gpt");
  const allowed = chatGpt.filter((account) => account.invoke_allowed === true).length;
  const accountPart = allowed
    ? t("setup.accounts", { n: allowed, m: chatGpt.length })
    : t("setup.noAccounts");

  if (setup === "claude-codex") return `${t("setup.claudeCodex")} ${accountPart}`;
  if (router.mode === "claude") return `${t("setup.routerPlans")} ${t("setup.routerClaude")}`;
  const writing = router.mode === "codex"
    ? t("setup.routerCodex")
    : t("setup.routerMixed", { first: t(`setup.first.${router.prefer}`) });
  return `${t("setup.routerPlans")} ${writing} ${accountPart}`;
}
