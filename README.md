# pi-extensions

Everything user-scope that makes this machine's pi behave the way it does: the operating
spec, the extensions, the skills, the prompts, the theme, the MCP servers, and the package
set. Clone it on a fresh machine, run `./install.sh`, and the agent that comes up is the
same one — same tools, same gates, same instruction file.

Written against **pi 1.5.2** (`@earendil-works/pi-coding-agent`). Extension APIs move; if a
newer pi rejects a file here, check it against `docs/extensions.md` in the pi version you
are on.

## Layout

| In this repo | Installed to | What it is |
| --- | --- | --- |
| `agent/AGENTS.md` | `~/.pi/agent/AGENTS.md` | Operating spec: role, values, safety line, refusal handling, reasoning procedure, response quality |
| `agent/settings.json` | merged into `~/.pi/agent/settings.json` | Package set, default provider/model/thinking level |
| `agent/mcp.json` | `~/.pi/agent/mcp.json` | `browser` (Playwright MCP over CDP :9222) and `rea` MCP servers |
| `agent/extensions/` | `~/.pi/agent/extensions/` | The seven extensions below |
| `agent/skills/` | `~/.pi/agent/skills/` | Pi-only skills (`memory`, `sinthink`, `obsidian-markdown`, `obsidian-bases`) |
| `agent/prompts/` | `~/.pi/agent/prompts/` | `/plan` and `/plan-approve` templates |
| `agent/themes/` | `~/.pi/agent/themes/` | `omarchy-system` theme |
| `agent/npm/package-lock.json` | reference only | Exact extension versions on the machine this was captured from |
| `skills/` | `~/.agents/skills/` | The ambient skill library — vendored snapshots, see [Skills](#skills) |
| `git-hooks/prepare-commit-msg` | `~/.config/git/hooks/` + `core.hooksPath` | Strips AI-agent attribution trailers from commit messages, every repo |
| `legacy/` | — | Extensions that are no longer loaded, kept for reference |
| `checks/` | — | Proves the install reproduces the layout |

### Extensions

| File | What it does |
| --- | --- |
| `dsh-plan.ts` | `/plan` enters plan mode and blocks mutations at `tool_call` (including inside codemode scripts). `/plan-approve` is the only way out — the model cannot approve its own plan |
| `dsh-parity.ts` | dsh's loop guards: per-tool operational rules, final-answer file-reference contract, oversized tool-result pruning, repeated-tool-call reminders |
| `dsh-accuracy.ts` | Read-before-edit enforcement, nested `AGENTS.md` injection, clock refresh as a durable message, `todo_write` |
| `dsh-accuracy/lib.ts`, `dsh-parity/lib.ts` | Shared helpers, each with a `selftest.mts` beside it |
| `sinthink.ts` | `sinthink` tool: A/E/R · C/V/N plan validation, save, status, and plan-vs-tree check |
| `memory-doctor.ts` | Memory vault lint on health, `/memory` report, daily-note graph link on settle, consolidation nudge |
| `herdr-agent-state.ts` | Herdr pane/agent state over its socket |
| `tps.ts` | Live tokens/s and TTFT in the status bar |

### Extension packages

Installed by pi from `agent/settings.json` on first start:

| Package | What it adds |
| --- | --- |
| `pi-lens` | LSP diagnostics, ast-grep search/replace, source checks |
| `pi-subagents` | `subagent`, workflows, council mode |
| `pi-web-access` | `web_search`, `fetch_content`, `source_check` |
| `pi-memory` | `memory_*` tools and the `~/brain` vault |
| `pi-background-tasks` | `bg_run`, `bg_status`, `bg_logs`, delegation |
| `@dietrichgebert/ponytail` | The lazy-senior-dev behaviour rules |

## Install

```sh
curl -fsSL https://pi.dev/install.sh | sh          # pi itself
git clone https://github.com/mariobgsp/pi-extensions ~/Projects/pi-extensions
~/Projects/pi-extensions/install.sh
pi                                                 # installs the npm packages on start
```

Then authenticate what needs it — `pi login` for the provider, `gh auth login` for the
GitHub tooling. `install.sh` is idempotent; re-run it after every pull. Real files it finds
in the way are moved aside to `<path>.pre-kit-<timestamp>`, never deleted.

`mcp.json` points the browser server at an existing Chromium started with
`--remote-debugging-port=9222`; start one or drop that server.

### Pinning the exact package versions

`agent/npm/package-lock.json` is the lockfile from the machine this kit was captured on. The
settings list is unpinned, so a fresh install takes current releases. For the exact versions:

```sh
cd ~/.pi/agent/npm && npm ci
```

## What this repo cannot carry

Not configuration, so not here:

- `auth.json`, `models-store.json`, and the settings bookkeeping keys (`lastChangelogVersion`,
  `extensionChangelogVersions`) — credentials and per-machine state.
- `sessions/` — conversation history.
- The memory vault itself (`~/brain`, `~/.pi/agent/memory`) — content, not tooling. The
  `memory` skill and `memory-doctor` extension that read it are here.
- `~/.pi/agent/sinthink/*.json` — per-feature plans, which belong to their projects.
- Per-project `.pi/` settings and project skills.
- `node_modules` (262 MB) — reinstalled by pi.

## Skills

`agent/skills/` are pi-only and shadow the ambient copies of the same name. `skills/` is the
ambient library pi reads from `~/.agents/skills/`; those are **vendored snapshots** of
upstream packs (mattpocock-skills, the remotion skills, caveman, fframes,
reverse-engineer-anything, …), not forks. When an upstream pack changes, refresh it from its
source rather than editing the copy here.

`omarchy-app` is not vendored: it ships with Omarchy at
`/usr/share/omarchy/default/agents/skills/omarchy-app`, and `install.sh` links it when that
directory exists.

## Gotchas

- A user agent under `~/.pi/agent/agents/` must not set `tools: inherit` — `tools` is a strict
  allowlist, so the child asks for a tool literally named `inherit` and the run fails. Omit
  `tools:` for the default set.
- `herdr-agent-state.ts` is generated by herdr. Reinstalling or updating herdr overwrites it,
  which breaks the symlink; re-run `install.sh` afterwards.

## Verify

```sh
./checks/install-layout.sh
```

Installs into a temp directory, then asserts every managed path links back to this repo, that
`settings.json` kept its packages and defaults, and that a second run adds no duplicate
package. Prints `PASS` or the exact failing path.
