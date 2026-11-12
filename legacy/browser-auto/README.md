# browser-auto

Autonomous browser for pi: ~11 thin tools backed by a persistent Python
HTTP daemon (stdlib `http.server` only — no FastAPI) owning one browser +
one persistent context + one page.

## Setup

```bash
pip install playwright playwright-stealth
python -m playwright install chrome   # preferred channel; falls back to bundled Chromium
```

`playwright-stealth` is optional (daemon runs without it, just less
stealthy). Python 3.14 is used to spawn the daemon (`python3.14`,
falling back to `python3`).

No build step: `package.json` declares `pi.extensions ["./index.ts"]`.
The TS client resolves `server.py` relative to `import.meta.url`
(never cwd), spawns it on first tool call with an ephemeral localhost
port, health-checks `/health`, records `{port,pid}` in
`~/.cache/pi-browser/daemon.json`, and kills the process group on
session shutdown.

## Tools

`browser_launch browser_navigate browser_snapshot browser_inspect
browser_fill browser_click browser_check browser_screenshot
browser_wait_for browser_wait_for_login browser_close`

Snapshots return `{ref,role,name,text}` nodes; refs feed fill/click/check.

## Engine option

`browser_launch` accepts `engine`:

- `playwright` (default) — full `engines/playwright_engine.py`:
  persistent profile `~/.cache/pi-browser/profile`, real
  user-agent/viewport/locale, `channel="chrome"` preferred,
  stealth applied per page.
- `nodriver` — stub (`engines/nodriver_engine.py`): returns a clear
  NOT-IMPLEMENTED error (`pip install nodriver` hint). A future worker
  implements the same method set
  (launch/navigate/snapshot/inspect/fill/click/check/screenshot/wait/
  wait_for_login/close) and it drops in via the daemon registry —
  no TS or daemon-core changes needed.

### Swap knob: Patchright

To use Patchright instead of playwright-stealth, `pip install
patchright` and change the import in `engines/playwright_engine.py` to
`from patchright.sync_api import sync_playwright` (API-compatible);
`stealth.py` then becomes redundant.

## Login handoff

`browser_wait_for_login` is a blocking detect-and-wait loop (timeout
clamped 120–300s, default 180) on `url_contains`/`selector`. The HUMAN
completes login/captchas in the headed window — the agent never
auto-solves captchas.
