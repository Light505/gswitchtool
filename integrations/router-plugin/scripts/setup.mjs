// Added by Light505 for gswitchtool (2026).
import path from "node:path";

export const directoryName = (value, fallback) => typeof value === "string" && /^[\w.-]+$/.test(value) && ![".", ".."].includes(value)
  ? value : fallback;
export const appDataDirectory = (home, target) => path.join(home, directoryName(target.appDataDir, ".gswitchtool"));
