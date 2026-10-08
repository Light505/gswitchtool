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

## The three parts

| Part | What it is | Installs from | Needs |
| --- | --- | --- | --- |
| **GSwitch Claude Tool** (the app) | Windows app that holds your Codex accounts and decides what Codex may run | Release installer, then updates itself | Nothing else; works without Claude |
| **Codex plugin** (`codex@gswitchtool`) | Claude Code plugin that sends Codex tasks to the app and shows its status (`/codex:...`) | Claude Code plugin list (`gswitchtool`) | The app open with Invoke Mode on, to run Codex |
| **Router plugin** (`router@gswitchtool`, optional, not released yet) | Claude Code plugin that picks who writes each coding task: a Claude worker or Codex (`/router:...`) | Same plugin list, once released; until then Dev only | The Codex plugin and Invoke Mode for modes `mixed` and `codex` |

Only the app holds accounts and rules. The plugins ask; the app checks every
request against your settings and runs it or refuses it. The app and the
plugins have separate version numbers and update separately: the app through
its own updater, the plugins through `/plugin update`.

How a task flows:

```
You ── set rules ──> GSwitch app (Invoke Mode, allowed models, accounts)

Without the router (or router mode off):
  /codex:gswitch-invoke ─> Codex plugin ─> app checks the rules ─> Codex on an allowed account
                                                 <─ result (account switches and resume happen here)
  Claude checks the result and reports to you.

With the router (mode mixed):
  coding task ─> router picks a worker
     ├─ Claude worker ─> edits in its own worktree ─> router check + apply
     └─ Codex ─> Codex plugin ─> app checks the rules ─> Codex ─> result
  Claude checks the result; on failure the router moves one step up its ladder.
```

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
Run it to install **GSwitch Claude Tool**. You can also download the installer
from the repository's **Releases** page on GitHub instead of building it.

Accounts and settings are kept in `.gswitchtool` in your home folder
(`C:\Users\<you>\.gswitchtool`), not in the install folder, so updating or
reinstalling keeps them. Credentials there are encrypted. Version 1.1.2 moved
them there from AppData once; the old folder is left untouched as a backup. They are separate from any upstream
GSwitch installed on the same computer.

### Updates

From version 1.1.0, the app checks the repository's GitHub releases when it
opens and every six hours. From 1.1.1 you can also check at any time with the
**Check for updates** button (the arrow in a circle, next to the language menu).
When there is a newer version it shows **GSwitch <version> is available**:

- **Update GSwitch** downloads it, checks its signature, and installs it over the
  current version. The app closes, updates, and keeps your accounts and settings.
- **Later** leaves everything as it is. The app does not ask again about that
  version until it next opens.

Nothing is installed without your choice. While Claude's delegated Codex work is
running, the app waits and asks you to update after it finishes.

The check uses the GitHub sign-in that Git already saved when you cloned the
repository; nothing to set up. If Git has no saved sign-in, the app finds no
updates; run `git pull` in the repository once to sign in. The sign-in stays on
your computer and is sent only to GitHub.

A version before 1.1.0 cannot update itself: install 1.1.0 once by hand, as
above.

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
4. Under **Accounts** in Invoke settings, put the accounts in the order you want
   them used, for example your larger plan first. GSwitch uses the first account
   that still has **Enough usage left** (20% of each usage window by default):
   before a task starts while nothing else runs, it switches to that account, and
   when an account runs out it switches to the next one in order. If none has
   enough, it takes the one with the most usage left.
5. **Codex tasks at once** (default 2) caps how many delegated tasks Claude can
   run in parallel; more wait their turn.
6. **Weekly reserve** (next to each account in the order): the share of that
   account's weekly limit automatic switching leaves unused, for example 30% to
   keep part of your main account's week for yourself. Below it, GSwitch moves
   tasks to other accounts and never fails over to it; if no other account has
   usage left, Invoke Mode pauses instead of using the reserve.

In **Default model per task**, you can suggest a model and effort for reviews,
research, mechanical edits, and complex work. Each choice must be one of the
allowed model/effort pairs above. These are recommendations Claude can follow;
they do not restrict the requests it can make.

**Start reset timers automatically** (off until you turn it on): a usage window
starts counting at the first request after it resets. With this on, GSwitch
checks your allowed accounts every ten minutes and sends any account whose window
has not started one short Wake message, the same as the **Wake** button, so its
reset timer is already running when you need it. Each Wake uses a tiny amount of
usage. The window tells you which accounts it woke.

A model that only some of your accounts can use, such as a model for a higher
plan, shows **Only on Pro** (or the plans that have it) in Invoke settings. If
you allow it and Claude uses it, GSwitch waits for other Codex tasks to finish,
then switches to the first account in your order that has the model. Today no
Codex model is limited to a plan, so nothing shows this label yet.

The app's version is shown next to its name in the toolbar. The palette button
near the right switches between the **Claude Code** (default), **Codex**, and
**Classic** palettes, and between System, Light, and Dark.

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

The router plugin is optional and not released yet; see [`router-guide.md`](./router-guide.md#install).

Start a new Claude Code session after installing or updating the plugin. To try
plugin changes that are not on `main` yet, see
[Working on the tool](#working-on-the-tool).

## 5. Use it in Claude Code

| You type | What happens |
| --- | --- |
| `/codex:gswitch-invoke <task>` | Claude hands that task to Codex. |
| `/codex:gswitch-invoke` | For the rest of this session, Claude hands Codex the work that suits it and keeps the rest. |
| Nothing | Claude does the work itself. While Invoke Mode is on, it may ask Codex for a read-only review of a non-trivial change before reporting back. |

While Invoke Mode is on, the [router plugin](./router-guide.md) can start Codex
through `gswitch-delegate` when its rules send a task to Codex.

Claude picks a model and effort from your allowed list: lighter for simple work,
stronger for complex work. Each Codex result ends with a line like:

```
[codex invoke] completed · thread 01a1… · job task-… · gpt-6-luna/low · write
```

`write` means Codex could edit files; reviews never have it. To continue earlier
work, ask Claude to continue that thread.

To keep Claude's usage low, the result is short, and the facts in it come from
the tool rather than from Codex:

| Line | Meaning |
| --- | --- |
| `Changed files (git): …` | What git shows changed during the run, with lines added and removed. |
| `Verify: passed` / `Verify: FAILED` | The test command Claude named, run by the tool after Codex finished. On a failure Codex gets one automatic retry in the same thread; after that, Claude takes over. |
| `SCOPE REQUEST: …` / `Scope: n change(s) declined` | Files Codex was stopped from changing, with its reason when given, and how many paths were declined. Claude decides whether to resume the same thread with a wider scope. |
| `WARNING: …` | Something does not add up, such as a file Codex says it changed that git shows unchanged. With `--write` and `--scope`, the run stops at the first edit outside `--scope`, before it happens, and reports it as a `SCOPE REQUEST` (verify is skipped); shell edits are still caught afterwards by `WARNING: changed outside --scope`. Claude then reads those files. `WARNING: protected text changed` means Codex altered rules marked as protected (between `gswitch-protected:start` and `gswitch-protected:end`); the run does not pass and Claude puts the original text back. |
| `Full answer: …` | A long answer was shortened; the whole answer is in that file. |
| `Worktree: applied …` / `Worktree kept: …` | When Claude runs two editing tasks at once, each works in its own copy of the repository, and the result is copied back into your working tree. A kept copy (a conflict that could not be resolved, or a failed test) is left for you with its reason; nothing in your working tree changes. The copies share your real `node_modules` and Rust build folder (so nothing is reinstalled), which means an install inside a copy changes those shared folders, just as it would in your working tree. |

OpenAI's stock commands (`/codex:review`, `/codex:status`, and others) still work
when you type them, but they do not go through GSwitch: no model allowlist and no
account switching.

## 6. When an account runs out

When Codex reports that the active account has used up its quota, GSwitch:

1. pauses the Codex work it is running;
2. picks the next allowed account in your order that has enough usage left (or,
   without an order, the one with the most), never one you have not allowed and
   never the account that just ran out;
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

- **Running Codex tasks:** while Invoke Mode is on, the **Codex tasks** strip
  above your accounts lists each delegated task: running or waiting its turn,
  model and effort, whether it can edit files, its project folder, thread, and
  how long it has run. **Stop** (click twice to confirm) ends a task at once;
  Claude is told you stopped it and does not restart it. **Watch** opens a
  terminal-style view of what Codex is doing, live: the task, Codex's messages,
  each command and its output, the files it edits, and when it finishes, with
  the tokens used so far.
- **History:** the **Activity** button (the clock icon in the toolbar) lists what
  Invoke Mode did: tasks started and how they ended, account switches and why,
  pauses and resumes, and automatic Wakes. **View log** on a finished task
  replays what Codex did. It keeps the latest 1,000 entries in
  `~/.gswitchtool/activity.jsonl`, with no credentials, prompts, or Codex output.
  Ended task rows include Codex's latest token totals when its rollout is
  available. The top summary groups task counts and total tokens from the last
  seven days by model and effort. Running-task token totals are not shown in the
  strip; they are available in **Watch** while its live log is open.
- **After a pause:** when Codex usage comes back, GSwitch shows a Windows
  notification and a notice listing the paused threads; tell Claude to continue
  them. While paused, the pause notice lists them too.
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
- **Invoke status:** `/codex:invoke-status` shows the same status Claude sees.

## 8. Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| `GSWITCH_UNAVAILABLE` | Open GSwitch Claude Tool. |
| `INVOKE_MODE_DISABLED` | Switch GSwitch to **Invoke**, or keep working without Codex. |
| `CODEX_SIGNED_OUT` | GSwitch shows **Codex is signed out**, so no run starts. Press **Switch** on an account allowed in Invoke Mode, then tell Claude to try again. `invoke-status` also reports it up front. |
| `MODEL_NOT_ALLOWED` / `REASONING_NOT_ALLOWED` | Claude asked for something you did not tick. It should choose again from your list; tick more in Invoke settings if needed. |
| `NO_ELIGIBLE_ACCOUNT`, `INVOKE_PAUSED`, or **Invoke Mode paused** | No allowed account has Codex usage left, so Claude paused. Wait for the reset, or allow another account and choose **Resume now**; then tell Claude to continue. |
| `USAGE_LIMIT_EXCEEDED` | Codex ran out on several accounts in a row during one task, so Claude paused. Tell Claude to continue when usage is available. |
| **Close Codex to continue** in GSwitch, or `EXTERNAL_CODEX_RUNNING` | Quit your own Codex app, CLI, or IDE extension so the account can be switched. |
| `CURRENT_ACCOUNT_UNKNOWN` | Save the account Codex is using in GSwitch, or finish **Review recovery** if GSwitch shows it. |
| The GSwitch window freezes while opening | Close it, end any leftover `msedgewebview2.exe` processes for GSwitch Claude Tool in Task Manager, and open it again. |
| Claude does not see a plugin change | Start a new Claude Code session. |
| Accounts are missing in a version before 1.1.2 | Versions before 1.1.2 kept data in AppData, and Windows gives an app started from Claude's desktop app its own private copy of AppData, so accounts added in a window opened from Claude did not appear when opening GSwitch from the Start menu. Update to 1.1.2 or later. If accounts are still missing, keep `~/.gswitchtool/startup.log` (each startup step, no account data). |
| GSwitch never offers an update | Run `git pull` in the repository once so Git saves your GitHub sign-in, then reopen the app. Versions before 1.1.0 cannot update themselves. |
| *Quit Codex* although no Codex window is open | GSwitch stops Codex's background service by itself; an IDE extension or a `codex` command running in a terminal still counts as open. |
| *… is already open. Close it before opening …* | That same build is already open. Close it before opening another copy. Dev and installed can run side by side. |
| Building fails while downloading libsodium | Some networks block its plain-HTTP download. Download `LATEST.tar.gz`, `libsodium-1.0.22-stable-msvc.zip`, and their `.minisig` files from https://download.libsodium.org/libsodium/releases/ into one folder and set `SODIUM_DIST_DIR` to it; the build still checks their signatures. |

## Roll back

Choose **Roll back to previous version** next to **Check for updates** in the
installed app and confirm **Reinstall GSwitch Claude Tool vX.Y.Z?**. It offers
the nearest older stable release and uses the same signed download and progress
as an update. Wait for Claude's delegated Codex work to finish before installing.
Dev does not update or roll back itself.

If the app will not start, close GSwitch and run `corepack pnpm run rollback` from the
repository folder. It opens the normal Windows installer for the release before
GitHub's latest published one. To choose a version, run
`corepack pnpm run rollback -- --to 1.7.0`; to see versions, run
`corepack pnpm run rollback -- --list`. Git needs your saved GitHub sign-in for the private
repository (run `git pull` once if needed).

Your accounts and settings stay; settings added after the chosen version may be
ignored. Versions before 1.1.2 are refused because they cannot see your saved
accounts. This does not restore an older copy of your data.

## Working on the tool

Changes are made on the `dev` branch and reach the installed app only through
`main` and a release. To try them before that:

**Work with the installed app, work on Dev.** The installed app and the `codex`
plugin (`/codex:...`) are the tools that do the work, including work on GSwitch
itself; they change only at a release you approve. GSwitch Claude Tool (Dev) and
the `codex-dev` plugin are only for trying a change, on throwaway tasks. Rebuilding
or restarting Dev never touches the installed app or tasks running through it. If
a release ever breaks the installed app, reinstall the previous version from the
GitHub releases page; Claude can also always work without Codex (Invoke Mode off).

**Test before a release (Windows).** On `dev`, run:

```bash
pnpm run test:dev
```

It builds **GSwitch Claude Tool (Dev)** and opens it the way the Start menu
would. Dev has its own accounts and settings in `~/.gswitchtool-dev` and Codex
home in `~/.codex-dev`; sign in to your accounts again in Dev. The installed
app can stay open. When you are done testing,
`pnpm run test:dev -- --done` closes only the dev build. Read-only Codex runs
(reviews) cannot run commands in Dev: `~/.codex-dev` has no elevated Windows
sandbox setup, which needs an administrator prompt and shares Windows sandbox
accounts with your everyday Codex. Test read-only runs against the installed app.

**The app, while changing code.** On `dev`, run:

```bash
pnpm run app:dev
```

It opens **GSwitch Claude Tool (Dev)** and rebuilds when the code changes. Dev
uses its own accounts and settings in `~/.gswitchtool-dev` and Codex home in
`~/.codex-dev`; sign in again there. The installed app can run at the same time.
The dev plugin is `codex-dev`; use `/codex-dev:gswitch-invoke` and
`/codex-dev:gswitch-review` to send tasks to the Dev build. After a plugin change,
`node scripts/plugin-dev.mjs` rebuilds and updates `codex-dev` in Claude Code
(start a new Claude Code session to use it).

**The plugin.** Start Claude Code from a terminal with the repository's copy of
the plugin instead of the installed one. In the repository folder:

```bash
corepack pnpm run claude:dev
```

You do not need the Claude Code CLI: without `claude` on PATH, this uses the
newest Claude Code bundled with Claude's desktop app (on Windows it lives in the
app's private package folder, whose path changes with each update). It runs
`claude --plugin-dir integrations/codex-plugin-cc/plugins/codex --settings
scripts/claude-dev-settings.json`.

`--plugin-dir` loads the plugin from your checkout for that session only, and
the settings file turns off the installed `codex@gswitchtool` for that session so
the two do not clash. Other sessions keep using the installed plugin. Start a new
session to pick up further changes.

**Publishing an update.** Once changes are on `main`, publish them to every
installed copy:

1. On `dev`, raise `"version"` in `src-tauri/tauri.conf.json` (for example
   `1.1.0` to `1.1.1`), run `pnpm run version:sync`, and commit.
2. Merge `dev` into `main` and push `main`.
3. On `main`, run:

   ```bash
   pnpm run release -- --notes "What changed"
   ```

It builds the installed app, signs it, and publishes a GitHub release with the
installer and `latest.json`. It refuses unless `main` is clean and matches
GitHub, and unless the version is new.

The signing key is `~/.tauri/gswitchtool-updater.key` on the maintainer's
computer. Keep a private backup of it: installed copies accept only updates
signed with this key, so losing it means everyone reinstalls by hand once with a
new key. Never commit or share it. Colleagues do not need it.

## Sharing with colleagues

Give them read access to the private repository. Each person installs the app,
adds their own accounts, and installs the plugin as above; nothing is shared
between computers.
