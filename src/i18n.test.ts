import { describe, expect, it } from "vitest";

import {
  createTranslator,
  formatCompactExpiry,
  formatDateTimeWithRelative,
  formatQuotaResetTime,
  resolveLocale,
} from "./i18n";

describe("GSwitch text and formatting", () => {
  it("formats with a supported system locale and otherwise with en-US", () => {
    expect(resolveLocale("fr-FR")).toEqual({ formatLocale: "en-US" });
    expect(resolveLocale("en_GB")).toEqual({ formatLocale: "en-GB" });
    expect(resolveLocale("zh-CN")).toEqual({ formatLocale: "zh-CN" });
    expect(resolveLocale("zh-TW")).toEqual({ formatLocale: "en-US" });
  });

  it("translates English text with placeholder values", () => {
    const t = createTranslator();
    expect(t("accounts.savedMany", { count: 3 })).toBe("3 saved accounts");
    expect(t("cli.available")).toBe("Codex CLI {version} available");
  });

  it("formats reset times with the system locale and relative time", () => {
    const timestamp = Date.UTC(2026, 0, 2, 12, 0, 0) / 1000;
    const nowMs = Date.UTC(2026, 0, 2, 11, 0, 0);
    const expectedDate = new Intl.DateTimeFormat("de-DE", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp * 1000));
    const expectedRelative = new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" }).format(1, "hour");

    expect(formatDateTimeWithRelative(timestamp, "de-DE", nowMs)).toBe(
      `${expectedDate} (${expectedRelative})`,
    );
  });

  it("keeps credit expiry compact while showing the year only across years", () => {
    const now = new Date(2026, 8, 26, 10, 0).getTime();
    const thisYear = new Date(2026, 9, 4, 13, 0).getTime() / 1000;
    const nextYear = new Date(2027, 0, 1, 10, 0).getTime() / 1000;
    expect(formatCompactExpiry(thisYear, "en-US", now)).toBe("in 8d 3h · 10/04 13:00");
    expect(formatCompactExpiry(nextYear, "en-US", now)).toContain("2027/01/01 10:00");
    expect(formatCompactExpiry(now / 1000 - 60, "en-US", now)).toBe("Expired");
  });

  it("formats quota reset time compactly across minute, day, and year boundaries", () => {
    const now = new Date(2026, 8, 27, 11, 35).getTime();
    const today = new Date(2026, 8, 27, 16, 30).getTime() / 1000;
    expect(formatQuotaResetTime(today, "en-US", now)).toBe("4h 55m · 09/27 16:30");
    const tomorrow = new Date(2026, 8, 28, 11, 35).getTime() / 1000;
    expect(formatQuotaResetTime(tomorrow, "en-US", now)).toBe("1d · 09/28 11:35");
    const nextYear = new Date(2027, 0, 1, 10, 0).getTime() / 1000;
    expect(formatQuotaResetTime(nextYear, "en-US", now)).toContain("2027/01/01 10:00");
    expect(formatQuotaResetTime(now / 1000 + 1, "en-US", now)).toContain("1m · ");
    expect(formatQuotaResetTime(now / 1000 - 1, "en-US", now)).toBe("Refresh to update");
  });

  it("rounds quota countdowns up without capping a real duration longer than five hours", () => {
    const now = new Date(2026, 9, 5, 12, 10).getTime();
    const fiveHours = now / 1000 + 5 * 60 * 60;
    expect(formatQuotaResetTime(fiveHours, "en-US", now)).toBe("5h · 10/05 17:10");
    expect(formatQuotaResetTime(fiveHours + 30, "en-US", now)).toBe("5h 1m · 10/05 17:10");
    expect(formatQuotaResetTime(fiveHours - 30, "en-US", now)).toBe("5h · 10/05 17:09");
  });
});
