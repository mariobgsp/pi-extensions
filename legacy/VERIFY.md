# crew_verify — the project verification gate

`crew_verify` runs four independent dimensions over a project, writes machine-readable
evidence to `<project>/.pi/verify/latest.json`, and returns a compact PASS/FAIL/SKIP
matrix plus `nextActions[]`. It is a **soft gate**: it warns, it never blocks a session.

**The automatic gate is off by default** and opt-in per project (see the Gate section below).
The tool, the report and the `/test-all` skill path are available either way.

It lives in `crew-verify.ts` (tool `crew_verify`, called directly — there is no recipe or wave to
look up) with one sibling helper, `ui_probe.py` (Playwright, same directory as the extension).

- **Absence of evidence is never PASS.** A missing test script, missing browser, missing
  vision model, unreachable URL, unparsable probe/judge output, or a report-write failure
  produce `SKIP` (nothing was checked) or `FAIL` (checked and broken) — never `PASS`.
- **A dimension is `PASS` only when every one of its checks actually ran and passed.** A
  `SKIP` item (command never spawned, budget starved, test runner exit 0 with no test count,
  route never probed before the probe deadline) or a `WARN` item demotes the dimension to
  `SKIP`, with a reason naming the checks that did not run.
- **The agent cannot grant its own completion.** Only the engine writes the report; the
  agent's "done" is a proposal the reviewer/advisor wave checks against the report + diff.

## The four dimensions

| Dimension | What it runs | PASS requires | Evidence |
| --- | --- | --- | --- |
| `unit` | config `unit.commands`, else detected: `package.json` `test:unit` → `test` (plus `--workspaces` when `workspaces` exist) → `pytest -q` → `go test ./...` | every command exits 0 **and prints a parsable, positive test count** (`# pass N`, `N passed`, `N tests ok`, `N passing`, phpunit `OK (N tests, …)`, rspec `N examples, …`, or one `ok <pkg> <time>` line per passing go package — for non-verbose `go test` that count is packages, not test cases). Exit 0 with no count ⇒ `SKIP` "no test count". **A failure count beats the exit code**: a runner that prints `fail(ed\|ing\|ures) N` or `# fail N` with N > 0 (`3 passed, 1 failed`, `1 failing, 2 passing`, jest `Tests: 1 failed, 1 passed, 2 total`) is a `FAIL` even when the process exited 0 (`test: "vitest run \| tee log"`, `jest \|\| true`, piped reporters). Best-effort parse: a passing suite that itself prints a count-shaped line like `2 failed attempts` also reads as a failure, so keep such text out of test stdout | exit code + last 64 KB tail per command |
| `api` | config `api.commands` (same runner) + config `api.endpoints` (HTTP) | every endpoint matches `expectStatus`/`expectJsonKeys`/`maxLatencyMs`. **An endpoint with an absolute `http(s)://` URL is probed even when no UI server answers**; only relative endpoints need the base URL (an unreachable base makes those ones a `SKIP` item, never a silent no-op) | method+URL, status, latency, body tail |
| `ui` | `ui_probe.py`: per route navigation, DOM checks, bounded non-destructive click sweep, screenshots | **every requested route probed** and every probed route clean: no pageerror, no 5xx, no same-origin 4xx, no broken image, no missing expected text/selector, **no empty document** (HTTP 200 with no visible text, < 5 elements **and no `canvas`/`svg`/`img`/`video`/`iframe`** ⇒ `FAIL` `empty document` — a text-free chart or poster page is *not* empty), no click *error* or non-inert dead click, **no unfiltered `console.error`** (unless `ui.failOnConsoleError:false` ⇒ `WARN`). A truncated run still reports `N/M routes probed (truncated)` against the **requested** count, and an *observed* `FAIL` is never downgraded to `SKIP` by the truncation | per-route JSON (errors, HTTP list, console, clicks, aria snapshot) + PNG per route |
| `visual` | vision judge over each route's screenshot against **written** `visual.routes[].expect[]` | every criterion `pass` on every route | judge JSON (`criteria[]` with mandatory verbatim `observed`, `defects[]`) + shot |

Derived verdicts (never asserted by the agent):

```
overall = FAIL  if any enabled dimension is FAIL
overall = PASS  if every enabled, non-waived dimension is PASS and at least one such dimension exists
overall = SKIP  otherwise (an enabled SKIP, a waiver, or an empty request — never PASS, never FAIL)
verifyComplete = (overall === PASS)
```

An enabled dimension that reports **no evidence** is a `SKIP`, and a SKIP is an `overall: SKIP` —
it is **not** turned into a FAIL. FAIL is reserved for checks that ran and broke.
The catch-all is deliberate and documented because it is the edge cases that bite:

- `dimensions: []` ⇒ `overall: SKIP`, `enabled: none`, and one action explaining that nothing
  was requested (never a vacuous PASS).
- A single waived dimension ⇒ `overall: SKIP` with the waiver as the reason: waivers stop a
  dimension from **blocking** a PASS (unit PASS + visual waived = `overall: PASS`), but a run in
  which *nothing* was scored is still not a verified run.
- Every FAIL/SKIP carries **at least one** `nextActions[]` entry, including the error paths
  (`failReport`: unknown dimension, malformed config, bad project root) — a verdict with no next
  step is a dead end for the agent.
- A dimension's SKIP entry is only added when its own items did not already produce one
  (an item-level blocker/major covers the same ground, so it is not duplicated).

A dimension is only `PASS` when it actually executed and produced evidence **for everything it
claimed to check**. `SKIP`/`WARN` items never make a dimension `FAIL`, but they stop it from being
`PASS` (it becomes `SKIP`, reason `N/M checks did not run or warned: …`), and each one emits its
own `nextActions[]` entry: `major`. The single exception is the overflow note below, which is
carried *beside* the verdict instead of demoting it. Sources of `WARN` items:

- horizontal overflow (`overflowX`): **a note, not a missing verdict**. The `ui` dimension keeps
  its PASS/FAIL/SKIP verdict and carries the overflow as a `WARN` item + action (repair the CSS);
  only checks that did not run can demote the dimension;
- `console.error` when `ui.failOnConsoleError:false` (with it `true`, the default, console
  errors are `FAIL` items — a render error caught by an error boundary and logged only to
  the console is a visibly broken page, not a clean one);
- a **cross-origin** request failure (`net::ERR_CONNECTION_REFUSED` against another port is
  kept; navigation aborts `net::ERR_ABORTED` are not failures);
- a click that produced no URL change, no DOM mutation, no dialog and no popup is recorded per
  click. On a control whose label is legitimately inert (`cancel|close|ok|apply|deselect|refresh|
  dismiss`) it is `result: "inert"` — a note, not a fail signal (`pages[].inertClicks`). Any
  other dead click (`Submit` that does nothing) still fails the route.

Destructive-looking clicks are never performed: they are counted per route
(`pages[].destructiveSkips`) with the skip reason, and that is not by itself a fail signal.
Destructive intent is read **statically** from two places, label first:

1. the control's **label** — its `innerText` plus `aria-label`/`title`, matched with word
   boundaries (`Payments` is not `pay`; class names, `href`s and `outerHTML` are *never*
   matched, so `class="reset-default-view"` no longer hides `Next page`);
   destructive verbs: delete, remove, archive, trash, sign out / log out, pay, buy, checkout,
   purchase, unsubscribe, revoke, transfer, suspend, deactivate, abort, wipe, purge, destroy,
   cancel/close account, cancel order, `clear all|data|everything|history|cart|log`;
2. the **inline handler / action attributes of the element and of its ancestor chain** — the
element's own attributes plus the owning `<form>`'s and up to 4 ancestors':
`onclick`/`onmousedown`/`onmouseup`/`onsubmit` (plus `formaction`/`action`) containing a
**write** (`fetch(…,{method:'POST'})`, `axios.delete(…)`, `xhr.open('PUT',…)`,
`method:'PATCH'`, `navigator.sendBeacon(…)`), and the htmx write attributes
`hx-post`/`hx-put`/`hx-patch`/`hx-delete` wherever they sit in that chain. So a
`<button>Save note</button>` inside `<form onsubmit="fetch('/orders/42/cancel',{method:'POST'})">`,
and a button inside an ancestor `<div hx-post="/orders/42/cancel">`, are **not clicked**.
A write verb in the **URL alone** is *not* destructive: the benign GET
`onclick="fetch('/api/soft-delete/preview')"` (label "Preview removal") **is** clicked,
because `delete` in a path is not a write. The destructive-verb list matches the *label* only.

Ceiling, stated honestly: this is static analysis, so three holes remain. (1) A handler attached
with `addEventListener` from minified/bundled JS is invisible. (2) A handler that calls a function
defined elsewhere — `onclick="submitOrder()"` with the write inside an inline or external
`<script>` — is invisible, because the call itself is not a write. (3) A control with no label and
no readable handler is protected only by the POST-form rule below.
Covered beyond the handler value itself: a submit control's own `formmethod` (it overrides the
form's `method`), the `form="<id>"` association when the control is not nested inside its form,
and `form.submit()` / `el.submit()` calls. `ui_probe.py` also
refuses to click inside any `<form>` whose **method is not `GET`** — the form's `action` string
alone is not treated as destructive (it is a URL), and the probe fails closed when it cannot read
the form membership at all. Two per-project escapes exist:
`ui.clickSkipRoutes: ["/orders"]` disables the sweep for those routes (they are still navigated
and DOM-checked) and `ui.clickAllow: ["Cancel order"]` force-clicks specific visible labels.

## Config — `<project>/.pi/verify.json`

Every field is optional. Absent file ⇒ the documented fallback: all four dimensions,
120 s budget, no auto-start, unit/api detected from the project, api+visual `SKIP` with a
reason, ui probing the `url` param else `http://localhost:3000`.

Worked example (every key):

```json
{
  "gate": false,
  "dimensions": ["unit", "api", "ui", "visual"],
  "timeoutMs": 120000,
  "start": { "command": "npm", "args": ["run", "dev"], "url": "http://localhost:3000", "readyTimeoutMs": 30000, "env": {} },
  "unit": { "commands": [{ "command": "npm", "args": ["run", "test:unit"] }] },
  "api": {
    "commands": [{ "command": "npm", "args": ["run", "test:api"] }],
    "endpoints": [
      { "method": "GET", "url": "http://localhost:3000/api/items", "expectStatus": 200,
        "expectJsonKeys": ["items"], "maxLatencyMs": 1500 }
    ]
  },
  "ui": {
    "url": "http://localhost:3000",
    "routes": ["/", "/items"],
    "clickBudget": 8,
    "clickSkipRoutes": ["/orders"],
    "clickAllow": ["Cancel order"],
    "failOnConsoleError": true,
    "expectedText": { "/": ["Items"], "/items": ["New item"] },
    "expectSelectors": { "/items": ["table"] },
    "ignoreConsole": ["[vite]", "Download the React DevTools", "favicon.ico"]
  },
  "visual": {
    "model": "openrouter/google/gemma-4-26b-a4b-it:free",
    "uploadOk": true,
    "routes": [
      { "path": "/", "expect": ["a header titled Items", "a visible 'New item' button"], "reference": ".pi/verify/refs/home.png" }
    ]
  },
  "waivers": [{ "dimension": "visual", "reason": "no vision model in this environment" }]
}
```

Rules:

- `command` is **argv[0] only** — never a shell string, never `shell: true`.
- Every path (`reference`, `config_path`) is resolved against the project root and refused
  if it escapes it; `configPath` escaping the root is a hard `FAIL`, not silent defaults.
  A declared `visual.routes[].reference` that is missing or escapes the root is **refused**,
  not silently dropped: the route gets a `SKIP` item `reference unavailable: <path>`, so the
  route can never `PASS` on a reference that was never shown to the judge.
- `env` is added on top of `process.env` for the start command and is never echoed into the
  report (`configUsed.start.env` is redacted). The **whole report** is deep-scrubbed just before
  it is written and before the tool text/details are built from it, so `target.url`,
  `target.startCommand`, `configUsed` (including `unit.commands[].args` and
  `api.endpoints[].url`), every `evidence` string and every `nextActions[].evidence` are covered.
  Three credential shapes are scrubbed: `key=value` / `key: value` (`token`, `secret`, `password`,
  `passwd`, `api_key`/`apikey`/`api-key`, `authorization`, and any `_key`/`-key`/bare `key`/
  `*_token`/`*secret` name — so `?key=`, `access_key=` and `private_key=` are covered, while a
  word that merely *ends* in `key` (`monkey=`) is not), `Authorization:`/`proxy-authorization:`
  with any of `Basic`/`Digest`/`NTLM`/`Bearer` — both the scheme *and* the credential are redacted,
  so a Basic base64 blob is caught,
  and `--flag value` — in a command line *and* in the JSON-array form of an argv
  (`"--password","SECRET_C"`). That is best-effort, not a guarantee. **Not scrubbed**: a bare
  secret with no credential-shaped name next to it — free-text `ui.expectedText` values and page
  text captured in `ariaSnapshot` are only caught when such a name precedes them — and anything
  that only exists inside a screenshot PNG, a PEM private-key block, a DSN with inline
  credentials (`postgres://user:pass@host`), and a credential field whose name merely *ends* in
  `key` without a separator (`publickey=`, `mykey=`, `regkey=`). Over-redaction of innocent text after a credential-
  shaped name (`token:`) or after a field literally named `key` is accepted. Keep **`.pi/verify/` (report + app
  screenshots) in `.gitignore`**.
- `ui.failOnConsoleError` (default `true`): an unfiltered `console.error` is a `FAIL` item;
  `false` downgrades it to a `WARN` (which still stops the dimension from being `PASS`).
  `ui.ignoreConsole` entries are **unanchored, case-insensitive substrings** of the console
  text: `["error"]` silently hides every message containing `error` (including a real
  `console.error`), so keep the entries specific (`"[vite]"`, `"favicon.ico"`).
- `ui.clickBudget` (default 8, clamped 0–40) is the maximum number of really-performed clicks
  per route. `0` means "click nothing" and is honoured as 0 (it is not coerced to the default).
- `ui.clickSkipRoutes` (default `[]`) lists routes whose click sweep is skipped entirely (they are
  still navigated, DOM-checked and screenshotted); `ui.clickAllow` (default `[]`) lists visible
  labels the sweep may click even though they look destructive. Both are the explicit escape from
  the static destructive detection above.
- `ui.timeoutMs` (default 60000) is the probe's own deadline. The probe stops starting new
  routes 1.5 s before it and the dimension is `SKIP`, never `PASS`; the routes it never visited
  are not evidence. Coverage is always reported against the **requested** count
  (`N/M routes probed (truncated)`), a killed probe reports `0/N routes reported`, and a `FAIL`
  observed before the deadline stays a `FAIL`.
- `visual.uploadOk` (default `true`): screenshots are base64-uploaded to the picked vision
  model. `false` ⇒ the visual dimension is `SKIP` `visual.uploadOk=false` and nothing leaves
  the machine. When it does run, the report records `visualUpload: {model, via, uploadOk,
  judgeCalls}` — `uploadOk` is `judgeCalls > 0`, i.e. it says whether anything was really sent,
  and the disclosure action (severity `info`) names the provider and the call count.
- A malformed `.pi/verify.json` FAILs the run with the JSON error (all dimensions `SKIP`) —
  it never silently falls back to defaults.
- `start` is only used when declared. `crew_verify {start:true}` with no `start` block ⇒
  ui+api `SKIP` with that reason. Without `start`, the given/default URL is probed as-is.
- A waiver makes a dimension `SKIP` with `waived: <reason>`, records it in the report and stops
  that dimension from blocking `PASS`. It does **not** manufacture a PASS by itself: a run whose
  only enabled dimension is waived is `overall: SKIP` (see the derived verdicts).
- `visual.model` is optional. The picker uses, in this order: `visual.model`, else
  `~/.pi/agent/vision-model.json` (the `/vision-model` default), else the session model if it
  takes image input, else the first available vision model with configured auth. Either of the
  first two reports `via: "configured"`, so on a machine that has a `vision-model.json` default
  the `via: "current"` / `via: "fallback"` branches are effectively dead — the credential and
  the provider in that file decide the upload, not the session. A requested model that does not
  resolve (or has no auth) is **not** silently replaced: the dimension is `SKIP`
  `no vision-capable model with configured auth`, never a PASS on some other model.
  **Auto-pick still uploads**: the chosen target is recorded in the report
  (`visualUpload: {model, via, uploadOk, judgeCalls}`) and an acknowledgement `nextActions`
  entry names the provider with the real call count, so nobody uploads a local app's screenshots
  off-machine without seeing it. That entry has severity **`info`** — it is a disclosure, not a
  fix to make, and it therefore never blocks the "verified complete" contract below. Set
  `visual.uploadOk:false` to refuse the upload (the dimension is then `SKIP`).

## Gate — off by default (opt-in)

The verification gate is **opt-in**. With no config, or with `"gate"` absent/false/invalid,
NONE of the automatic gate runs or appears:

- no `project_verify` rule is injected into the system prompt (`before_agent_start` reads the
  config **per turn** from `ctx.cwd`, never at extension load);
- no `verify:` footer status is set;
- `agent_end` never notifies (TUI), and `crew_close` returns no verification reminder or warning.

Always available regardless of the knob — explicit invocation is unchanged:

- the `crew_verify` tool and its report at `.pi/verify/latest.json`;
- the crew run's reviewer/advisor, which reads that same `.pi/verify/latest.json`;
- the `/test-all` skill path.

Opt in per project with this in `<project>/.pi/verify.json`:

```json
{ "gate": true }
```

The gate then comes back with two noise guards: `agent_end` warns only when **source files
actually changed since the last report** (a turn that touched nothing only refreshes the status),
and the same unchanged tree never warns twice. Anything that is not the boolean `true` — missing
file, invalid JSON, `"gate": "yes"` — fails safe to **off**.

## Usage — `crew_verify`

```
crew_verify {}                         → ctx.cwd + .pi/verify.json + all enabled dimensions
crew_verify {project_root:"…", url:"http://localhost:3000", dimensions:["unit","api","ui"], start:true, timeout_ms:120000}
```

The tool is called directly — no recipe step — and its evidence reaches the crew run's reviewer
through the report at `.pi/verify/latest.json`.

Parameters: `project_root` (default `ctx.cwd`), `url` (default `config.ui.url` →
`config.start.url` → `http://localhost:3000`), `dimensions` (subset of
`unit,api,ui,visual`; an unknown name FAILs the run), `config_path` (default
`.pi/verify.json`, must stay inside `project_root`), `timeout_ms` (clamped 5000–600000),
`start` (default: only when `config.start` exists).

Scoping with `dimensions:[…]` is honest about what was *not* requested: the unrequested
dimensions are still listed, but with `enabled: false` and `status: SKIP` "not in the requested
dimension set". They do not block `PASS`, and the matrix's `enabled:` list names only the
requested dimensions — `crew_verify {dimensions:["api"]}` with a passing api is `overall: PASS`
`(enabled: api)`.

`crew_close` and the `agent_end` notice resolve the report by the project root that was last
verified, not only by `ctx.cwd` — verifying `{project_root:X}` and then closing from elsewhere
still sees the fresh report.

Handoff: **reviewer** reads `.pi/verify/latest.json` + the diff; **advisor/synthesizer**
consume `nextActions[].severity`. A SKIP is not a pass — it is an instruction to say why
the evidence could not be produced.

## Bounded loop

`iteration` increments on every `crew_verify` for the same project while `overall != PASS`
and resets to 1 on PASS. `iteration > 3` ⇒ `escalated: true` and the return text starts
with `ESCALATED — 3 verify cycles without PASS. Stop and ask the user.` Fix → re-run, at
most 3 times, then the user decides. The header's `iteration N/3` is clamped to 3 once
escalated; the JSON keeps the real count (`iteration: 8` with `maxIterations: 3`).

## The "verified complete" contract (advisor / reviewer)

A task may be called complete only when:

1. `overall === "PASS"` **and** `verifyComplete === true` in `.pi/verify/latest.json`, and
2. `sourceFingerprint` still matches the sources (the report is not stale — `crew_close`
   and `agent_end` both warn when it is), and
3. every `blocker`/`major` `nextActions[]` entry has been resolved or explicitly waived with a
   reason. Entries with severity **`info`** are disclosures (e.g. "screenshots were uploaded to
   <provider>") and need no resolution — a PASS that only carries disclosures is still complete.
   A PASS run can legitimately carry a `major`: an overflow note is a real, fixable defect that
   does not change the `ui` verdict, so it stays listed until fixed or waived.

Anything else: report the failing/SKIP dimension, its `reason`, and its `evidence` — do not
summarise it as "tests pass".

## Report — `<project>/.pi/verify/latest.json`

Written atomically (tmp + rename) on **every** exit path, including FAIL and SKIP. If the
write fails, `reportPath` is `null` and the text says `report: NOT WRITTEN (<reason>) —
treat as unverified` (a write failure can never produce PASS).

```json
{
  "schemaVersion": 1,
  "id": "verify-20260921T134011Z",
  "createdAt": "2026-09-21T13:40:11.000Z",
  "project": "/abs/p",
  "iteration": 1,
  "maxIterations": 3,
  "escalated": false,
  "target": { "url": "http://localhost:3000", "urlSource": "config.start.url", "startCommand": "npm run dev", "serverStartedByVerify": true },
  "visualUpload": { "model": "openrouter/google/gemma-4-26b-a4b-it:free", "via": "configured", "uploadOk": true, "judgeCalls": 2 },
  "configPath": ".pi/verify.json",
  "configUsed": { "...effective normalized config, secrets redacted..." },
  "sourceFingerprint": "sha256:ab12cd34…",
  "fingerprintTruncated": false,
  "revision": [{ "path": "src/app.ts", "mtimeMs": 1758450000000, "size": 4210 }],
  "newerSources": 3,
  "dimensions": [
    { "name": "unit", "enabled": true, "status": "FAIL", "reason": "1/1 checks failed", "durationMs": 812,
      "items": [{ "name": "npm test", "status": "FAIL", "reason": "npm test exit=1 — 1 failed",
        "evidence": { "command": "npm test", "exitCode": 1, "outputTail": "…", "artifacts": [] } }] },
    { "name": "api", "enabled": true, "status": "FAIL", "reason": "1/2 checks failed", "durationMs": 1204, "items": [] },
    { "name": "ui", "enabled": true, "status": "FAIL", "reason": "0/2 routes clean — /: pageerror+missing text+click", "durationMs": 18430,
      "items": [{ "name": "/", "status": "FAIL", "reason": "pageerror x is not defined; 1 click error(s)",
        "evidence": { "command": "python3.14 ui_probe.py --spec .pi/verify/probe-spec.json", "exitCode": 0,
          "outputTail": "{\"route\":\"/\",\"status\":\"FAIL\",…}", "artifacts": [".pi/verify/shots/root.png"] } }] },
    { "name": "visual", "enabled": true, "status": "SKIP", "reason": "no vision-capable model with configured auth", "durationMs": 12, "items": [] }
  ],
  "overall": "FAIL",
  "verifyComplete": false,
  "waived": [{ "dimension": "visual", "reason": "no vision model in this environment" }],
  "nextActions": [
    { "dimension": "api", "severity": "blocker", "target": "GET http://localhost:3000/api/items -> 200",
      "action": "Fix …: status 404 (expected 200)", "evidence": "status 404" }
  ],
  "timestamps": { "startedAt": "…", "finishedAt": "…" }
}
```

Bounded: `items` ≤ 50/dimension, `outputTail` ≤ 2000 chars (capture keeps the last 64 KB),
`nextActions` ≤ 20 (the returned text shows ≤ 8 per run), `revision` ≤ 200 entries,
fingerprint walk capped at 4000 files / depth 12 and skips
`node_modules .git dist build out .next .venv venv __pycache__ .pi/verify coverage target .cache`.

Artifacts: `<project>/.pi/verify/shots/<slug>.png` per route, up to 3 `-click-<n>.png` for
clicks that changed state. There is **no `-error.png`**: the sweep re-navigates to the route
before the shot is taken, so such a file was byte-identical to the clean one and lied about
what it showed. `ui_probe.py` prints exactly one JSON object on stdout (diagnostics on stderr,
exit 0 whenever JSON was printed) and never starts a server.

## Processes, trust boundary, safety

- Every child (test command, probe, dev server) is `spawn(detached: true)` in its own
  process group and killed with `process.kill(-pid)` in a `finally`; `session_shutdown`
  and `process.on("exit")` are extra insurance. A dev server started by `crew_verify` is
  reaped at the end of that run — no orphans.
- Nothing is spawned at import/factory time; no timers are registered at load.
- The probe never touches `~/.cache/pi-browser` (that profile belongs to the live
  browser-auto daemon) and never uses `page.accessibility` (removed in Playwright 1.62).
- Captured output is capped; response bodies are only kept as a capped tail; `configUsed` is
  redacted and obvious credentials are scrubbed from config + evidence tails (best-effort, not
  a guarantee). `.pi/verify/` holds real command output and screenshots of the app — treat it
  as a secret-bearing directory and keep it out of git.

## Install / activate

```
# 1. source of truth
/home/mariobgsp/Projects/pi-extensions/mandatory-todo-delegation.ts
/home/mariobgsp/Projects/pi-extensions/crew-verify.ts
/home/mariobgsp/Projects/pi-extensions/ui_probe.py

# 2. what pi actually loads (extension discovery = ~/.pi/agent/extensions/*.ts)
ln -sf /home/mariobgsp/Projects/pi-extensions/mandatory-todo-delegation.ts \
       /home/mariobgsp/.pi/agent/extensions/mandatory-todo-delegation.ts
ln -sf /home/mariobgsp/Projects/pi-extensions/crew-verify.ts \
       /home/mariobgsp/.pi/agent/extensions/crew-verify.ts

# 3. activate: /reload in a session, or start a new session (the writer never does this)
```

Both `.ts` files must be symlinked: `mandatory-todo-delegation.ts` statically imports its
sibling `./crew-verify.ts`, so linking only the dispatcher loads neither the crew tools nor
`crew_verify` — the sibling cannot resolve from `~/.pi/agent/extensions/`, so the dispatcher's
own evaluation aborts.

Measured with jiti 2.7.0 (the loader pi uses): a symlinked module's relative imports and
`import.meta.url` both resolve against the **symlink** path, so the module URL reports
`~/.pi/agent/extensions/`, not the repo. The probe still finds the script because `probeScriptPath()`
also tries `dirname(realpathSync(here))` and `~/.pi/agent/extensions` as candidates ⇒ keep **one**
`ui_probe.py` beside the extension files in the repo; the probe resolves it from the symlink location
or the real target. If a symlink is not possible, copy the `.ts` to both directories **and** copy
`ui_probe.py` to both.
Backup of the previous installed copy: `~/.pi/agent/extensions/mandatory-todo-delegation.ts.bak-<ts>`.

The running session keeps the old module in memory until `/reload` or a new session, so
`crew_verify` does not exist in a session that was already open when the file changed.
