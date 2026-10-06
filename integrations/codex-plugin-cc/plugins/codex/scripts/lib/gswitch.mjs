// Added by Light505 for gswitchtool (2026): client for the GSwitch Invoke Mode endpoint. See CREDITS.md in gswitchtool.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const GSWITCH_CONFIG_DIR_ENV = "GSWITCH_CONFIG_DIR";
// Tauri keeps GSwitch's configuration in a directory named after its bundle
// identifier; GSWITCH_CONFIG_DIR overrides it.
const GSWITCH_IDENTIFIER = "com.ginbing.gswitch";
const ENDPOINT_FILE = "invoke-endpoint.json";
const REQUEST_TIMEOUT_MS = 10_000;

const ERROR_MESSAGES = {
  GSWITCH_UNAVAILABLE: "GSwitch is not running or its Invoke endpoint is unavailable. Ask the user to open GSwitch.",
  INVOKE_MODE_DISABLED: "Invoke Mode is off in GSwitch. Only the user can turn it on; do not delegate through invoke.",
  MODEL_NOT_ALLOWED: "That Codex model is not in the allowed Invoke profiles. Run invoke-status and choose an allowed model.",
  REASONING_NOT_ALLOWED:
    "That reasoning effort is not allowed for the chosen model. Run invoke-status and choose an allowed effort.",
  UNAUTHORIZED: "GSwitch refused the request. Ask the user to restart GSwitch.",
  BAD_REQUEST: "GSwitch could not read the request.",
  UNKNOWN_METHOD: "This GSwitch version does not support the request.",
  UNAVAILABLE: "GSwitch could not answer the request."
};

export class GSwitchError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.UNAVAILABLE);
    this.code = ERROR_MESSAGES[code] ? code : "UNAVAILABLE";
  }
}

export function resolveGSwitchConfigDir(env = process.env, platform = process.platform) {
  if (env[GSWITCH_CONFIG_DIR_ENV]) {
    return env[GSWITCH_CONFIG_DIR_ENV];
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), GSWITCH_IDENTIFIER);
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", GSWITCH_IDENTIFIER);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), GSWITCH_IDENTIFIER);
}

function readEndpoint(env) {
  try {
    const endpoint = JSON.parse(fs.readFileSync(path.join(resolveGSwitchConfigDir(env), ENDPOINT_FILE), "utf8"));
    if (typeof endpoint.endpoint === "string" && typeof endpoint.token === "string") {
      return endpoint;
    }
  } catch {
    // A missing or unreadable file means GSwitch has not published an endpoint.
  }
  throw new GSwitchError("GSWITCH_UNAVAILABLE");
}

/** Sends one request to GSwitch and resolves with its result. */
export function callGSwitch(method, params = {}, options = {}) {
  const { endpoint, token } = readEndpoint(options.env ?? process.env);
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = net.createConnection({ path: endpoint });
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const timer = setTimeout(
      () => finish(new GSwitchError("GSWITCH_UNAVAILABLE")),
      options.timeoutMs ?? REQUEST_TIMEOUT_MS
    );

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, token, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      let message;
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new GSwitchError("UNAVAILABLE"));
        return;
      }
      if (message.error) {
        finish(new GSwitchError(message.error.code));
      } else {
        finish(null, message.result ?? {});
      }
    });
    socket.on("error", () => finish(new GSwitchError("GSWITCH_UNAVAILABLE")));
    socket.on("close", () => finish(new GSwitchError("GSWITCH_UNAVAILABLE")));
  });
}

export function readInvokeStatus(options = {}) {
  return callGSwitch("status", {}, options);
}

export function validateInvocation(model, reasoningEffort, options = {}) {
  return callGSwitch("validate", { model, reasoning_effort: reasoningEffort }, options);
}
