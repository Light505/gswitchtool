// Added by Light505 for gswitchtool (2026): client for the GSwitch Invoke Mode endpoint. See CREDITS.md in gswitchtool.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const GSWITCH_CONFIG_DIR_ENV = "GSWITCH_CONFIG_DIR";
// GSwitch Claude Tool keeps its data in ~/.gswitchtool; before 1.1.2 it used a
// directory named after its bundle identifier. GSWITCH_CONFIG_DIR overrides both.
const GSWITCH_DATA_DIR = ".gswitchtool";
const GSWITCH_IDENTIFIER = "com.light505.gswitchtool";
const ENDPOINT_FILE = "invoke-endpoint.json";
const REQUEST_TIMEOUT_MS = 10_000;

const ERROR_MESSAGES = {
  GSWITCH_UNAVAILABLE: "GSwitch is not running or its Invoke endpoint is unavailable. Ask the user to open GSwitch.",
  INVOKE_MODE_DISABLED: "Invoke Mode is off in GSwitch. Only the user can turn it on; do not delegate through invoke.",
  MODEL_NOT_ALLOWED: "That Codex model is not in the allowed Invoke profiles. Run invoke-status and choose an allowed model.",
  REASONING_NOT_ALLOWED:
    "That reasoning effort is not allowed for the chosen model. Run invoke-status and choose an allowed effort.",
  CURRENT_ACCOUNT_UNKNOWN:
    "The Codex account ran out, but GSwitch cannot identify the account Codex is using (it may not be saved, or an earlier switch needs recovery in GSwitch), so it did not switch. Tell the user to check GSwitch.",
  EXTERNAL_CODEX_RUNNING:
    "The Codex account ran out, but the user's own Codex stayed open or the user cancelled the switch in GSwitch, so accounts were not switched. Tell the user.",
  CODEX_SHUTDOWN_FAILED: "The Codex account ran out, but Codex did not stop for the account switch. Tell the user.",
  NO_ELIGIBLE_ACCOUNT: "The Codex account ran out and no other account allowed in Invoke Mode has usable quota.",
  INVOKE_PAUSED: "GSwitch paused Invoke Mode because no Codex account it may use has usage left.",
  ACCOUNT_SWITCH_FAILED: "The Codex account ran out and GSwitch could not switch to another account. Tell the user.",
  ACCOUNT_VERIFICATION_FAILED:
    "The Codex account ran out, but the replacement account could not be verified, so work did not resume. Tell the user.",
  UNKNOWN_LEASE: "GSwitch no longer tracks this Codex run. Ask the user to check GSwitch.",
  MODEL_UNAVAILABLE:
    "No Codex account GSwitch may use offers this model with usage left, so the task did not start. Choose another allowed model from invoke-status, or tell the user.",
  UNAUTHORIZED: "GSwitch refused the request. Ask the user to restart GSwitch.",
  BAD_REQUEST: "GSwitch could not read the request.",
  UNKNOWN_METHOD: "This GSwitch version does not support the request.",
  UNAVAILABLE: "GSwitch could not answer the request."
};

// Codex usage is used up everywhere GSwitch may switch: the user decides what
// happens next, so the invoking model stops all work instead of carrying on.
export const PAUSE_CODES = new Set(["NO_ELIGIBLE_ACCOUNT", "INVOKE_PAUSED"]);

export const PAUSE_ALL_WORK =
  "PAUSE ALL WORK: stop now. Do not continue this task or any other task yourself, and do not start, resume, or retry any Codex work. Tell the user that work is paused, list each unfinished Codex thread ID so it can be resumed, say when usage resets if known, and wait for the user's instructions.";

/** The instruction given with every pause, with the reset time when known. */
export function pauseInstruction(resumesAt = null, now = Date.now()) {
  const seconds = Number(resumesAt);
  const reset =
    Number.isFinite(seconds) && seconds > 0
      ? `Codex usage resets around ${new Date(seconds * 1000).toLocaleString()} (${untilText(seconds * 1000 - now)}); GSwitch resumes Invoke Mode then, or earlier if the user resumes it.`
      : "No reset time is known; Invoke Mode stays paused until the user resumes it in GSwitch.";
  return `${reset} ${PAUSE_ALL_WORK}`;
}

function untilText(milliseconds) {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) {
    return `in about ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `in about ${hours} h ${minutes % 60} min` : `in about ${hours} h`;
}

export class GSwitchError extends Error {
  constructor(code, detail = null) {
    const message = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.UNAVAILABLE;
    // A pause carries its reset time; a refused switch, its transaction's reason.
    super(
      PAUSE_CODES.has(code)
        ? `${message} ${pauseInstruction(detail)}`
        : detail
          ? `${message} GSwitch reason: ${detail}.`
          : message
    );
    this.code = ERROR_MESSAGES[code] ? code : "UNAVAILABLE";
    this.detail = detail;
  }
}

export function resolveGSwitchConfigDir(env = process.env) {
  if (env[GSWITCH_CONFIG_DIR_ENV]) {
    return env[GSWITCH_CONFIG_DIR_ENV];
  }
  return path.join(os.homedir(), GSWITCH_DATA_DIR);
}

/** The data directory of GSwitch Claude Tool before 1.1.2. */
export function resolveLegacyGSwitchConfigDir(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), GSWITCH_IDENTIFIER);
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", GSWITCH_IDENTIFIER);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), GSWITCH_IDENTIFIER);
}

function readEndpoint(env) {
  const dirs = env[GSWITCH_CONFIG_DIR_ENV]
    ? [resolveGSwitchConfigDir(env)]
    : [resolveGSwitchConfigDir(env), resolveLegacyGSwitchConfigDir(env)];
  for (const dir of dirs) {
    try {
      const endpoint = JSON.parse(fs.readFileSync(path.join(dir, ENDPOINT_FILE), "utf8"));
      if (typeof endpoint.endpoint === "string" && typeof endpoint.token === "string") {
        return endpoint;
      }
    } catch {
      // A missing or unreadable file means GSwitch has not published an endpoint there.
    }
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
        finish(new GSwitchError(message.error.code, message.error.detail ?? null));
      } else {
        finish(null, message.result ?? {});
      }
    });
    socket.on("error", () => finish(new GSwitchError("GSWITCH_UNAVAILABLE")));
    socket.on("close", () => finish(new GSwitchError("GSWITCH_UNAVAILABLE")));
  });
}

/**
 * A worker's connection to GSwitch. It stays open for the whole run because
 * GSwitch stops tracking the worker when the connection closes. Requests are
 * answered in order, one line each.
 */
export class GSwitchSession {
  static async open(options = {}) {
    const { endpoint, token } = readEndpoint(options.env ?? process.env);
    const socket = net.createConnection({ path: endpoint });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", () => reject(new GSwitchError("GSWITCH_UNAVAILABLE")));
    });
    return new GSwitchSession(socket, token);
  }

  constructor(socket, token) {
    this.socket = socket;
    this.token = token;
    this.nextId = 1;
    this.pending = [];
    this.buffer = "";
    this.closed = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.receive(chunk));
    const fail = () => {
      this.closed = true;
      for (const pending of this.pending.splice(0)) {
        pending.reject(new GSwitchError("GSWITCH_UNAVAILABLE"));
      }
    };
    socket.on("error", fail);
    socket.on("close", fail);
  }

  request(method, params = {}) {
    if (this.closed) {
      return Promise.reject(new GSwitchError("GSWITCH_UNAVAILABLE"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(`${JSON.stringify({ id, token: this.token, method, params })}\n`);
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const pending = this.pending.shift();
      if (!pending) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        pending.reject(new GSwitchError("UNAVAILABLE"));
        continue;
      }
      if (message.error) {
        pending.reject(new GSwitchError(message.error.code, message.error.detail ?? null));
      } else {
        pending.resolve(message.result ?? {});
      }
    }
  }

  close() {
    this.closed = true;
    this.socket.end();
  }
}

export function readInvokeStatus(options = {}) {
  return callGSwitch("status", {}, options);
}
