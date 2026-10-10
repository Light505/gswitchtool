# Architecture

GSwitch is a local Tauri 2 desktop application. Its architecture is deliberately
smaller than a general account-management platform.

## Runtime boundary

- Rust is the trusted application boundary. It owns credentials, Codex App
  Server interaction, filesystem mutation, process checks, persistence, and
  safety-critical state transitions.
- React and TypeScript own presentation, transient form state, and direct user
  interaction.
- Vite builds the frontend; local CSS defines the small desktop design system.
- The WebView calls explicit Tauri commands. GSwitch has no HTTP API,
  network listening port, daemon, or remote-control surface. Its only other
  entry point is the Invoke Mode endpoint: a per-launch named pipe (Unix
  socket outside Windows) for the Claude Code integration, which can read
  Invoke policy, validate a request, and register and coordinate Codex workers
  with account failover, but cannot change policy, accounts, or credentials.

The frontend asks for user-level actions such as add, switch, refresh, redeem,
or Wake. It does not orchestrate their internal steps or receive the stored
credential document. Switch and reset-credit failures cross IPC as a small
serialized error code, not a Rust display string or raw provider error.

The identifier ending in `.dev` selects the development identity. The installed
build keeps data in `~/.gswitchtool` and uses the default `~/.codex`; it alone
adopts the old AppData store. Dev keeps separate data in `~/.gswitchtool-dev`
and uses `~/.codex-dev` unless its environment already sets `CODEX_HOME`.
Accounts and credentials are not copied between builds; sign in again in Dev.
Each data folder has its own `app-instance.lock`, so the same build cannot be
opened twice while Dev and the installed build can run side by side.

## State ownership

| State | Canonical owner | GSwitch responsibility |
| --- | --- | --- |
| Effective live Codex identity | Codex runtime | Inspect, match, and verify before reporting it |
| Live file-backed credential | `CODEX_HOME/auth.json` | Preserve the complete document and replace it only through the switch transaction |
| Credential-store policy | Effective Codex configuration or managed policy | Read and verify it; never silently override it |
| Saved account metadata | Rust-owned `accounts.json` | Persist identity, display fields, quota summaries, active state, and opaque credential references only |
| Saved credential and recovery secrets | Rust-owned Stronghold vault | Preserve complete credential documents, reset IDs, idempotency keys, and rollback material behind a native-credential-manager-protected root key |
| Account-store health | Rust-owned recovery state | Open a recovery-only workspace when the store cannot be read; never infer an empty library |
| OAuth and managed token refresh | Codex | Use official flows and preserve refreshed complete documents |
| Read-only account metadata | ChatGPT backend response | Match the returned workspace entry and cache only normalized fields |
| Quota and reset-credit facts | Codex/OpenAI response | Normalize and cache them without inventing missing values |
| External Codex process state | Operating system | Detect known or uninspectable runtimes before sensitive operations |
| Pending switch/reset recovery | GSwitch account store | Persist enough intent to resume safely and idempotently |
| Claude Code setup and Invoke policy (derived mode, allowed Codex pairs, task defaults) | Rust-owned `invoke.json` | Change it only from WebView commands; keep task defaults inside the allowed model/effort pairs |
| Invoke Mode activity and delegated-task token totals | Rust-owned `activity.jsonl` | Store task metadata and aggregate token counts only; read token totals from Codex rollouts without retaining prompts or output |
| Per-account Invoke eligibility | `accounts.json` (`invoke_allowed`) | Default to not allowed; keep the choice across a new sign-in for the same identity |
| Screen and dialog state | React component tree | Keep it transient, derived, and free of stored secrets; selected saved-account IDs are permitted, credentials and export paths are not |

The header's **Claude Code** panel is the only setup editor. Rust saves
`claude_setup` in `invoke.json` and derives Invoke Mode: off for `claude-only`,
on for `claude-codex`, and on for `router` unless its mode is `claude` with
review `off`. Missing setup in an older file derives from its Invoke Mode flag.

Rust atomically publishes the secret-free `claude-setup.json` projection in the
existing installed/Dev data folder at startup and on setup saves. Plugins read
this file; they do not own or mutate the setup. Its version-1 shape is exactly:

```json
{
  "version": 1,
  "setup": "claude-only",
  "router": {
    "mode": "mixed",
    "prefer": "codex",
    "sampling": "on",
    "claudeAllowed": { "haiku": ["low", "medium"], "sonnet": ["low"], "opus": [] },
    "claudeOnlyReview": "on"
  },
  "codexSpeed": { "mode": "normal", "fastMinRemaining": 20 }
}
```

`router` is always present. Setup values are `claude-only`, `claude-codex`,
and `router`; modes are `mixed`, `claude`, and `codex`; review is `on` or
`off`. Workers are ordered Haiku, Sonnet, Opus; efforts are low, medium, high,
xhigh, max. Defaults allow Haiku low/medium and every listed effort for Sonnet
and Opus, with mixed mode, Codex first and review on. `prefer` accepts `codex`,
`claude`, or `price`; older files without it default to `codex`. Rust rejects
unknown options other than lenient preferences; Rust and plugin readers treat invalid `prefer` values as missing.
`sampling` accepts `on` or `off`, defaults to `on` for missing or invalid values, and lets the router try cheaper or untested allowed workers on about one in ten trivial/small first attempts.
Publication failure returns a save error and attempts to restore the saved
policy; startup logs publication failure and continues. A successful human
setup save ends an Invoke pause. Plugins consume the setup starting with the
next message.

`codexSpeed` in the same setup owns `mode` (`normal`, `fast`, `orchestrator`) and `fastMinRemaining` (0–90, default 20); missing or invalid values default independently without resetting policy.
`run_begin` resolves the turn-only `default` or `priority` tier for every run from the owner setting, lease request, catalog Fast support and current account usage; it never sets the thread tier.
Rust owns the best-effort `codex-runs.jsonl` comparison log beside `claude-setup.json`, retaining the newest 5,000 finished tasks with speed, timing and optional tokens, without credentials or account identifiers.
The read-only `results_summary` command (`results.rs`) reads the last 20 MB of the router's `results.jsonl` (`~/.gswitchtool-router` or `~/.gswitchtool-router-dev`) and of `codex-runs.jsonl`, and returns per worker and difficulty counts, first-try passes and median time, tokens and API-price USD; its output holds no titles, project paths, or session, agent or job identifiers.
The read-only `claude_plugins` command (`plugins.rs`) reads Claude Code's own `~/.claude/plugins/installed_plugins.json` and reports whether the Codex and router plugins (dev names for the dev build) are installed and their versions; it never writes and returns no paths.
`task_result` may also carry `self_report` (the worker's parsed `RESULT` line), `files_changed`, `lines_added`, `lines_deleted`, `verify` (`passed`, `failed`, `skipped`, `none`), `verify_retries`, `scope_requests`, and `token_breakdown` / `long_prompt_tokens` (input, cached input, output, reasoning output; long prompt = above 272K input tokens); `invoke_ipc.rs` reads each leniently, so a missing, wrong-typed, out-of-range or unlisted value is logged as null and never fails the request or reaches the log as text. Entries stay `version: 1`.

Unknown, stale, timed-out, or conflicting state remains unknown. A cache is a
projection, not a second authority over runtime or provider facts.

The initial workspace snapshot names the saved account of a reset that needs
recovery and whether retrying can no longer help. The provider credit and
idempotency key remain in Rust-owned storage.

Interrupted credential saves use a separate encrypted pending index. The
explicit recovery command returns only a recovered count; Rust verifies each
document's stable identity and the recorded account generation before a
metadata commit, then retires the protected entry. Neither the index nor its
contents is an IPC value.

## Rust module boundaries

Keep the backend flat and organized by concrete responsibility:

- `lib.rs`: Tauri setup, managed state, plugins, and command registration;
- `commands.rs`: thin IPC adapters, sanitized application snapshots, and the
  `spawn_blocking` scheduling boundary for filesystem, provider, process, and
  App Server work;
- `accounts.rs`: saved-profile metadata, secret-generation transactions,
  operation serialization, store coordination,
  damaged-store recovery, pending credential recovery, and in-memory operation
  state;
- `app_server.rs`: lifecycle and protocol boundary for the official Codex App
  Server;
- `chatgpt.rs`: read-only ChatGPT quota and account-metadata HTTP boundary;
- `codex.rs`: `CODEX_HOME`, effective storage mode, and live auth-file access;
- `cli_update.rs`: version inspection and explicit handoff to the installed
  Codex CLI's official update command;
- `identity.rs`: credential classification, stable non-secret identity, and
  fingerprints used for comparisons;
- `intake.rs`: OAuth, bounded auth-document batch import, versioned portable export serialization, and API-key intake;
- `migration.rs`: one-shot, allowlisted local Codex/Cockpit discovery,
  read-only envelope decoding, sanitized previews, and revalidated handoff to
  `intake.rs`;
- `switching.rs`: live-account reconciliation, file-store enablement, switching,
  removal, and interrupted-switch recovery;
- `quota.rs`: quota normalization/cache, the managed refresh shared by switch,
  quota, and Wake, reset-credit selection, redemption, and redemption recovery;
- `wake.rs`: Wake policy, narrow Responses transport, sequential Wake All,
  cancellation, and per-account outcomes;
- `invoke.rs`: Invoke Mode policy persistence, the credential-free model
  catalog read, whitelist normalization, and request validation;
- `invoke_ipc.rs`: the token-checked local endpoint for the Claude Code
  integration's read, validate, and worker methods;
- `failover.rs`: the Invoke worker registry, the single-failover rule,
  stopping registered App Servers, replacement-account selection, and the
  switch through `switching.rs`;
- `runtime.rs`: external Codex process detection and stopping a registered
  Invoke worker's App Server process tree;
- `storage.rs`: versioned JSON persistence and atomic/private writes;
- `vault.rs`: Rust-only Stronghold snapshot and native root-key boundary for
  credential and recovery secrets;
- `types.rs`: backend state and sanitized serializable view models.

Split a module only after it has acquired two real responsibilities. Do not add
`services/`, `repositories/`, `domain/`, `providers/`, dependency injection,
SQLite, or an ORM for hypothetical growth.

## Frontend boundary

The application remains a one-screen React app with a small typed Tauri adapter.
Use React's normal state model: one owner for each state value, derived data
instead of copies, props for controlled child views, and local state for dialogs
and forms. A global store, router, component framework, or generic API client
requires a demonstrated current need.

The native dialog is used to choose account-export paths or, after an explicit
user action, one documented Cockpit data folder. Rust reads selected import
paths and owns portable export lookup, serialization, destination, and write;
it returns only sanitized import summaries, local-account previews, and export
counts. Raw file bytes, source records, paths, keys, and credential documents
do not cross the WebView boundary. File-count, per-file, and aggregate-size
limits plus identity deduplication belong to Rust rather than React. Local
migration is a one-shot command with no startup scan, watcher, scheduler, or
background job. OAuth links are short-lived, user-visible links associated with
an in-memory login session.

The WebView persists display preferences only: the palette, the light/dark
mode, and the selected sidebar section. They are not account state and must not
share storage with credentials, provider data, or recovery records.

Potentially blocking Rust commands are asynchronous and move their existing
synchronous domain operation to Tauri's blocking worker pool. This keeps the
window able to repaint, scroll, and accept unrelated input without weakening
the Rust operation mutex or cross-process lock. Automatic quota reads release
that lock during network waiting and reacquire it only to commit a projection
after checking the saved credential generation. Startup reads account secrets
from one Stronghold session instead of reopening the snapshot for every card.
React keeps point-operation state local: a single-account quota refresh
replaces only that account's quota projection, while a full workspace reload is
reserved for initial state or a real topology change. When a reload reads saved
projections, a newer saved projection replaces the in-memory one and an older
one does not.

`accounts.json` is metadata, not a vault. Its version-4 account records carry
an opaque credential reference and generation; complete documents and
credential-adjacent recovery values are loaded only inside Rust from the
Stronghold snapshot. The snapshot is encrypted with a random root key held by
the platform credential manager. Vault writes commit before metadata advances
to a new generation; a failed metadata commit can leave only unreachable
encrypted material, never a metadata reference to an unwritten secret. Legacy
inline stores migrate atomically after every saved secret is readable and still
derives its recorded identity. The live Codex `auth.json` remains a distinct
file-backed projection, never proof of vault state.

## Isolated Codex profiles

OAuth, authentication-only switch/import/quota fallback, and reset redemption
may run an official Codex App Server in a short-lived GSwitch-owned
`CODEX_HOME`. This isolates the operation from the user's live Codex identity.
Refreshed credentials are accepted only after the returned document still
matches the expected account identity. Ordinary switch validation, quota,
account metadata, and Wake use the small Rust-owned ChatGPT HTTP boundary first.
A valid switch snapshot updates only normalized non-secret metadata; it neither
refreshes nor rewrites credentials. API-key switching does no provider request.

## Mutation boundary

Operations that may persist or refresh credentials share one Rust-owned
in-process mutex and cross-process file lock within that build's data folder.
Each build loads its own account store into memory once. Its `app-instance.lock`
prevents a second copy of that build from opening, while the separate Dev and
installed folders let the two builds run side by side.
Live switching adds external Codex
process checks because a GSwitch lock has no authority over another Codex
process. The first check precedes provider work; a second check plus the original
live fingerprint gates the atomic `auth.json` replacement.

A switch is one backend transaction, not a frontend sequence or file-copy
shortcut. It validates a saved snapshot first, permits one isolated managed
refresh only after a ChatGPT 401 or 403, and verifies the write by locally
rereading identity without starting another App Server. Pending state, guarded
rollback, and recovery remain inside the same transaction. See
[workflows.md](./workflows.md) for its semantics and [security.md](./security.md)
for its invariants.

## Dependency rule

Use official current Codex and Tauri interfaces where they exist. New
dependencies and abstractions require a present product, platform, or safety
need. Do not add infrastructure because a future feature might use it.
