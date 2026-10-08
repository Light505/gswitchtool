// Added by Light505 for gswitchtool (2026).
export const models = [
  { short: "haiku", id: "claude-haiku-5-5", display: "Haiku 5.5" },
  { short: "sonnet", id: "claude-sonnet-5-5", display: "Sonnet 5.5" },
  { short: "opus", id: "claude-opus-5-5", display: "Opus 5.5" }
];
export const efforts = ["low", "medium", "high", "xhigh", "max"];
export const workerNames = models.flatMap(({ short }) => efforts.map((effort) => `${short}-${effort}`));
// Measured or estimated API USD per agent-session attempt.
export const costPerTask = Object.freeze({
  "haiku-low": 0.14, "haiku-medium": 0.23, "haiku-high": 0.36, "haiku-xhigh": 0.61, "haiku-max": 2.58,
  "sonnet-low": 0.48, "sonnet-medium": 0.62, "sonnet-high": 1.24, "sonnet-xhigh": 3.33, "sonnet-max": 14.19,
  "opus-low": 0.63, "opus-medium": 1.45, "opus-high": 2.16, "opus-xhigh": 4.82, "opus-max": 13.04
});
export function needsApproval(name) {
  return !Object.hasOwn(costPerTask, name) || costPerTask[name] > costPerTask["opus-medium"];
}
export function defaultAllowed() {
  return {
    haiku: ["low", "medium"],
    sonnet: ["low", "medium", "high", "xhigh", "max"],
    opus: ["low", "medium", "high", "xhigh", "max"]
  };
}
