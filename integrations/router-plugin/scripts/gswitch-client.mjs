// Added by Light505 for gswitchtool (2026).
// Reads Invoke status from the running GSwitch app: the same "status" request the Codex plugin's
// invoke-status sends (integrations/codex-plugin-cc/plugins/codex/scripts/lib/gswitch.mjs).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { efforts } from "./workers.mjs";

// Tests set GSWITCH_ROUTER_INVOKE_STATUS to a JSON file holding a status; when set, the app is not asked.
const injected = "GSWITCH_ROUTER_INVOKE_STATUS";

/** Resolves with GSwitch's Invoke status, or null when the app does not answer within timeoutMs. */
export function readInvokeStatus(appDataDir, timeoutMs = 1500) {
  const file = process.env[injected];
  if (file) {
    try { return Promise.resolve(JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""))); }
    catch { return Promise.resolve(null); }
  }
  let endpoint, token;
  try { ({ endpoint, token } = JSON.parse(fs.readFileSync(path.join(appDataDir, "invoke-endpoint.json"), "utf8").replace(/^﻿/, ""))); }
  catch { return Promise.resolve(null); }
  if (typeof endpoint !== "string" || typeof token !== "string") return Promise.resolve(null);
  return new Promise((resolve) => {
    let buffer = "", settled = false;
    const socket = net.createConnection({ path: endpoint });
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      resolve(result && typeof result === "object" && !Array.isArray(result) ? result : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, token, method: "status", params: {} })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        finish(message.error ? null : message.result);
      } catch { finish(null); }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/** on, off, paused or unknown (no answer). */
export function invokeState(status) {
  if (!status) return "unknown";
  if (!status.invoke_mode) return "off";
  return status.paused ? "paused" : "on";
}

/** Allowed Codex models and efforts ({ model: [efforts] }) while Invoke is on; never account data. */
export function codexAllowedFrom(status) {
  const allowed = {};
  if (invokeState(status) !== "on" || !Array.isArray(status.allowed_invocation_profiles)) return allowed;
  for (const profile of status.allowed_invocation_profiles) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile?.model ?? "") || !Array.isArray(profile.reasoning_efforts)) continue;
    const list = efforts.filter((effort) => profile.reasoning_efforts.includes(effort));
    if (list.length) allowed[profile.model] = [...new Set([...(allowed[profile.model] || []), ...list])];
  }
  return allowed;
}
