// Added by Light505 for gswitchtool (2026).

const STATUSES = ["done", "partial", "stopped"];
const CONFIDENCES = ["high", "medium", "low"];
const FELT = ["trivial", "small", "moderate", "hard", "high-risk"];

/**
 * Reads the worker's last `RESULT:` line, for example
 * `RESULT: done · confidence: high · felt: small · verify-fails: 0`.
 * Parts may be separated by `·`, `|`, `;` or `,`; a missing or invalid part
 * is null. Returns null when the answer has no RESULT line.
 */
export function parseSelfReport(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("RESULT:"))
    .at(-1);
  if (line === undefined) return null;
  const [first = "", ...rest] = line.slice("RESULT:".length).split(/[·|;,]/);
  const status = first.trim().toLowerCase();
  const report = { status: STATUSES.includes(status) ? status : null, confidence: null, felt: null, verifyFails: null };
  for (const part of rest) {
    const separator = part.indexOf(":");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim().toLowerCase();
    if (key === "confidence" && CONFIDENCES.includes(value)) report.confidence = value;
    else if (key === "felt" && FELT.includes(value)) report.felt = value;
    else if (key === "verify-fails" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) report.verifyFails = Number(value);
  }
  return report;
}
