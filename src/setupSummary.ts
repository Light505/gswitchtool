// Added by Light505 for gswitchtool (2026): the Home page's one-sentence
// summary of how Claude Code and Codex share the work under the saved settings.

import { createTranslator } from "./i18n";
import type { AccountView, InvokeSettings } from "./types";

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
