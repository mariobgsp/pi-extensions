# pi-extensions

Source of truth for the pi coding-agent extensions loaded on this machine.
`~/.pi/agent/extensions/` is a symlink farm into this repo — edit here, not there.

## What is here

| Path | Loaded by pi | What it does |
| --- | --- | --- |
| `crew-verify.ts` | yes | `crew_verify` tool: runs a project's own checks (unit, api, ui, visual), returns a PASS/FAIL/SKIP matrix, writes `.pi/verify/latest.json` |
| `ui_probe.py` | helper of `crew-verify.ts` | Playwright probe: routes, console errors, overflow, screenshots for the ui/visual dimensions |
| `delegate.ts` | yes | `delegate` tool: resolves a thinking level from the goal and prints the exact background-subagent call to run |
| `token-rate.ts` | yes | token rate / pricing helpers |
| `token-ledger.ts` | yes | per-session token usage ledger |
| `herdr-agent-state.ts` | yes | Herdr pane/agent state |
| `browser-auto/` | yes | autonomous browser thin-client (Node index + Python server/engines) |
| `vision-handoff.ts` | no | vision-model handoff helper, imported by nothing yet |
| `.pi/verify.json` | config | per-project verify config (`start`, dimension commands, `visual.uploadOk`) |
| `SELFTEST.md`, `VERIFY.md` | no | raw evidence and design notes for the verify gate |
| `upstream-reports/` | no | upstream pi-subagents reports and a patch |

`caveman-native.js` is **not** here: it is generated into `~/.pi/agent/extensions/` by
`caveman enable pi` and hardcodes a local node path, so it stays a real file.

## Install

```sh
git clone https://github.com/mariobgsp/pi-extensions ~/Projects/pi-extensions
cd ~/.pi/agent/extensions
for f in crew-verify.ts delegate.ts herdr-agent-state.ts token-rate.ts token-ledger.ts browser-auto; do
  [ -e "$f" ] && rm -rf "$f"
  ln -s ~/Projects/pi-extensions/"$f" "$f"
done
```

A user agent under `~/.pi/agent/agents/` must not set `tools: inherit` — `tools` is a strict
allowlist, so the child asks for a tool literally named `inherit` and the run fails. Omit
`tools:` to get the default set.

## Verifying a project

`crew_verify` executes; the policy (when to run it, what counts as evidence, the 3-cycle cap)
lives in `~/.pi/agent/AGENT.md` §5.

```sh
crew_verify {project_root: <path>}     # matrix over unit, api, ui, visual + nextActions
```

Missing evidence is never a pass: no test script, no browser, no vision model, or an unreachable
URL means SKIP or FAIL. A dimension passes only when every check ran and passed, and any WARN
blocks PASS. The tool never blocks the session. Configure the run in `<project>/.pi/verify.json`
(`start` command, dimension commands, `visual.uploadOk`); the old `"gate": true` key is inert —
the automatic per-turn rule and end-of-turn warning were removed.

## Checks

```sh
cd ~/.pi/agent
NODE_PATH=~/.pi/agent/npm/node_modules bun tests/crew-verify.check.ts
NODE_PATH=~/.pi/agent/npm/node_modules bun tests/delegate.check.ts
```
