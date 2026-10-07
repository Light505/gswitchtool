// Added by Light505 for gswitchtool (2026).
export const models = [
  { short: "haiku", id: "claude-haiku-5-5", display: "Haiku 5.5" },
  { short: "sonnet", id: "claude-sonnet-5-5", display: "Sonnet 5.5" },
  { short: "opus", id: "claude-opus-5-5", display: "Opus 5.5" }
];
export const efforts = ["low", "medium", "high", "xhigh", "max"];
export const workerNames = models.flatMap(({ short }) => efforts.map((effort) => `${short}-${effort}`));
export function defaultAllowed() {
  return { haiku: ["low", "medium"], sonnet: ["low", "medium", "high", "xhigh", "max"] };
}
