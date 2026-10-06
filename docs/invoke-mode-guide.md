# Using GSwitch Claude Tool with Claude Code

GSwitch Claude Tool is GSwitch with an optional **Invoke Mode**. In Invoke Mode,
Claude Code can hand work to Codex to save Claude usage, while GSwitch decides
which Codex models Claude may use and switches Codex accounts automatically when
one runs out of usage.

You stay in control:

- **You** add accounts, turn Invoke Mode on or off, choose which models and
  reasoning efforts Claude may use, and choose which accounts may be used
  automatically.
- **Claude** sends work to Codex only when you ask, and may ask Codex to review
  its own changes while Invoke Mode is on.
- **GSwitch** checks every request, and when an account runs out of usage it
  switches to another allowed account and resumes the same Codex conversation.

## What you need

- Windows 10 or 11 (macOS and Linux builds use the same steps with their own
  Tauri prerequisites).
- The [Codex CLI](https://developers.openai.com/codex/cli/) installed and
  signed in at least once: `npm install -g @openai/codex`.
- [Claude Code](https://claude.com/claude-code).
- One or more ChatGPT accounts with Codex access. Automatic switching needs at
  least two.
- Access to the private `Light505/gswitchtool` repository.

## 1. Install the app

There is no published installer; build it from the repository. You need
[Node.js 22](https://nodejs.org), [Git](https://git-scm.com),
[Rust](https://rustup.rs), and the Microsoft C++ Build Tools with the
**Desktop development with C++** workload (WebView2 is already part of
Windows 11).

```bash
git clone https://github.com/Light505/gswitchtool.git
cd gswitchtool
npm install -g pnpm@10.17.1
pnpm install --frozen-lockfile
pnpm run build:installer
```

`build:installer` builds only from a clean, up-to-date `main`, so the installed
app is always a reviewed version. The installer is written to
`src-tauri/target/release/bundle/nsis/GSwitch Claude Tool_<version>_x64-setup.exe`.
Run it to install **GSwitch Claude Tool**.

It does not update itself. To update, close GSwitch Claude Tool, then
`git checkout main && git pull`, `pnpm install --frozen-lockfile`,
`pnpm run build:installer`, and run the new installer over the old one; there is
no need to uninstall. Accounts and settings are kept in your user profile, not
in the install folder, so updating or reinstalling keeps them. They are separate
from any upstream GSwitch installed on the same computer.

## 2. Add your accounts

Open GSwitch Claude Tool and add accounts as in GSwitch:

1. **Save the account Codex is using now** (Add account → Find on this
   computer, or the *Save current account* shortcut). Automatic switching needs
   the current account to be saved.
2. Add each other account with **Add account → Sign in**, which opens the
   official Codex sign-in in your browser.

Credentials stay encrypted on your computer. Claude never sees them.

## 3. Turn on Invoke Mode

1. In the toolbar, switch **Manual** to **Invoke**.
2. Open **Invoke settings** (the sliders icon next to it) and tick the models and
   reasoning efforts Claude may use. Each model lists only the efforts it
   supports. Claude can never use anything you leave unticked.
3. On each account card, turn on **Allow in Invoke Mode** for the accounts GSwitch
   may switch to automatically. An account you leave off is never used
   automatically, whatever its quota.

Keep GSwitch Claude Tool open while you use Invoke Mode. Switching back to
**Manual** turns everything off: Claude cannot use Codex through GSwitch and no
account changes automatically.

## 4. Install the Claude Code plugin

In Claude Code, add this repository's plugin. It replaces OpenAI's stock Codex
plugin, so remove that one first if you installed it.

```
/plugin marketplace add Light505/gswitchtool
/plugin install codex@gswitchtool
```

This installs the plugin from GitHub `main`. To update it after `main` changes:

```
/plugin marketplace update gswitchtool
/plugin update codex@gswitchtool
```

Start a new Claude Code session after installing or updating the plugin. To try
plugin changes that are not on `main` yet, see
[Working on the tool](#working-on-the-tool).

## 5. Use it in Claude Code

| You type | What happens |
| --- | --- |
| `/codex:gswitch-invoke <task>` | Claude hands that task to Codex. |
| `/codex:gswitch-invoke` | For the rest of this session, Claude hands Codex the work that suits it and keeps the rest. |
| Nothing | Claude does the work itself. While Invoke Mode is on, it may ask Codex for a read-only review of a non-trivial change before reporting back. |

Claude picks a model and effort from your allowed list: lighter for simple work,
stronger for complex work. Each Codex result ends with a line like:

```
[codex invoke] completed · thread 01a1… · job task-… · gpt-6-luna/low · write
```

`write` means Codex could edit files; reviews never have it. To continue earlier
work, ask Claude to continue that thread.

OpenAI's stock commands (`/codex:review`, `/codex:rescue`, `/codex:status`, and
others) still work when you type them, but they do not go through GSwitch: no
model allowlist and no account switching.

## 6. When an account runs out

When Codex reports that the active account has used up its quota, GSwitch:

1. pauses the Codex work it is running;
2. picks the allowed account with the most usable quota, never one you have not
   allowed and never the account that just ran out;
3. if you have Codex open yourself (the app, the CLI, or an IDE extension), shows
   **Close Codex to continue** in its window. Close Codex and it carries on, or
   choose **Cancel switch**;
4. switches and verifies the new account, then resumes each piece of work in its
   same Codex conversation with the same model and settings.

The window then names both accounts. If a switch cannot be verified, nothing is
switched, and Claude reports the reason with the thread so the work can continue
later.

### When every account runs out

If no allowed account has Codex usage left, there is nothing to switch to.
GSwitch then **pauses Invoke Mode**:

- All Codex work stops, and GSwitch starts no new Codex work, including reviews.
- Claude is told to **pause all work**. It stops instead of finishing the task
  itself, tells you which Codex threads are unfinished and when usage resets, and
  waits for you.
- GSwitch shows **Invoke Mode paused** with the time usage resets.

The pause ends by itself when the first of those accounts resets. To end it
sooner, allow another account, switch Invoke Mode off and on, or choose
**Resume now**. Then tell Claude to continue: it resumes each thread where it
stopped. To keep working without Codex instead, tell Claude to carry on itself.

## 7. Check what happened

- **Allowed models and status:** in Claude Code, ask Claude to run
  `invoke-status`, or look at GSwitch's toolbar and Invoke settings.
- **A specific run:** Codex records every conversation in `~/.codex/sessions`.
  This shows the model, effort, and whether it could edit files (replace the ID):

  ```bash
  grep -h '"turn_context"' ~/.codex/sessions/*/*/*/*<thread-id>*.jsonl
  ```

- **Open the conversation in Codex:** `codex resume <thread-id>`. Typing there
  continues it on the current account.
- **Jobs in a Claude session:** `/codex:status` and `/codex:result <job-id>`.

## 8. Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| `GSWITCH_UNAVAILABLE` | Open GSwitch Claude Tool. |
| `INVOKE_MODE_DISABLED` | Switch GSwitch to **Invoke**, or keep working without Codex. |
| `MODEL_NOT_ALLOWED` / `REASONING_NOT_ALLOWED` | Claude asked for something you did not tick. It should choose again from your list; tick more in Invoke settings if needed. |
| `NO_ELIGIBLE_ACCOUNT`, `INVOKE_PAUSED`, or **Invoke Mode paused** | No allowed account has Codex usage left, so Claude paused. Wait for the reset, or allow another account and choose **Resume now**; then tell Claude to continue. |
| `USAGE_LIMIT_EXCEEDED` | Codex ran out on several accounts in a row during one task, so Claude paused. Tell Claude to continue when usage is available. |
| **Close Codex to continue** in GSwitch, or `EXTERNAL_CODEX_RUNNING` | Quit your own Codex app, CLI, or IDE extension so the account can be switched. |
| `CURRENT_ACCOUNT_UNKNOWN` | Save the account Codex is using in GSwitch, or finish **Review recovery** if GSwitch shows it. |
| The GSwitch window freezes while opening | Close it, end any leftover `msedgewebview2.exe` processes for GSwitch Claude Tool in Task Manager, and open it again. |
| Claude does not see a plugin change | Start a new Claude Code session. |
| *… is already open. Close it before opening …* | The installed app and the dev app share accounts, so only one runs at a time. Close the one that is open. |
| Building fails while downloading libsodium | Some networks block its plain-HTTP download. Download `LATEST.tar.gz`, `libsodium-1.0.22-stable-msvc.zip`, and their `.minisig` files from https://download.libsodium.org/libsodium/releases/ into one folder and set `SODIUM_DIST_DIR` to it; the build still checks their signatures. |

## Working on the tool

Changes are made on the `dev` branch and reach the installed app only through
`main` and `pnpm run build:installer`. To try them before that:

**The app.** Close GSwitch Claude Tool, then run this on `dev`:

```bash
pnpm run app:dev
```

It opens **GSwitch Claude Tool (Dev)** and rebuilds when the code changes. It
uses the same accounts and Invoke settings as the installed app, so anything you
add or change in one appears in the other. Only one of them can be open at a
time; opening the second shows a message naming the one to close. The Claude
Code plugin talks to whichever is open.

If a dev change upgrades the account file format, an older installed app cannot
read that file until the change reaches `main` and is installed.

**The plugin.** Start Claude Code from a terminal with the repository's copy of
the plugin instead of the installed one. In the repository folder:

```bash
claude --plugin-dir integrations/codex-plugin-cc/plugins/codex --settings scripts/claude-dev-settings.json
```

`--plugin-dir` loads the plugin from your checkout for that session only, and
the settings file turns off the installed `codex@gswitchtool` for that session so
the two do not clash. Other sessions keep using the installed plugin. Start a new
session to pick up further changes.

## Sharing with colleagues

Give them read access to the private repository. Each person installs the app,
adds their own accounts, and installs the plugin as above; nothing is shared
between computers.
