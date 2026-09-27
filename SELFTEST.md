# SELFTEST — crew_verify evidence (raw, observed)

Everything below was run on this machine on 2026-09-21 (node v26.8.1, python 3.14.7,
Playwright python 1.62.0, chromium at `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`).
No `/reload`, no pi restart, no writes to `~/.pi/agent/extensions/` beyond the backup+symlink
deploy step.

## REMOVED: `decide-guard.ts` (the whole extension), 2026-09-22

**Sections below that document decide-guard are historical.** The extension file, its live symlink in
`~/.pi/agent/extensions/`, its A/B harness (`decide-guard.ab.mjs`), its preflight probe and the Laya
backend it briefly carried were all deleted on 2026-09-22. No session loads them; `/guard`, the `decide`
tool and the tool_call gate no longer exist.

Why: it was cheap (in-process, ~10 µs per bash/write call, zero dependencies, zero tokens, zero network)
but **never observably did anything** — across 687 recorded sessions there is no real block and no real
notification attributable to it, only its own source strings and test fixtures. The `decide` tool it
exposed had been called 24 times in 687 sessions, which is what had already ended the Laya backend (see
§ "Removed: the Laya backend" below). Zero recorded saves against a 49 KB file of 223 assertions is a
choice about insurance, and the owner chose not to carry it.

Consequences recorded here so they are not rediscovered later:

- `.pi/verify.json` `unit.commands` is now `[]` — `node decide-guard.ts` was the project's **only** unit
  check, so `crew_verify` has no unit evidence from this point on. That is a real loss of regression
  cover, not a neutral change.
- `laya-backup/` holds every artifact (`decide-guard.ts.bak-1117-lines` = the deleted shipped revision,
  `.bak-1684-lines` = the Laya revision) plus `re-enable-symlink.txt` and exact restore commands.
- `.laya/bridge.py` + `.laya/README.md` stay as a standalone rebuild recipe (nothing imports them).

Still live in this repo and unaffected: `mandatory-todo-delegation.ts` (symlinked), `herdr-agent-state.ts`,
`token-rate.ts`, `vision-handoff.ts`, `ui_probe.py`, `browser-auto/`.

## 1. Parse / type-strip check (no tsc, no esbuild on this machine)

```console
$ node --version
v26.8.1
$ which tsc esbuild   # → none available
$ node --experimental-strip-types --input-type=module -e \
    "import('./mandatory-todo-delegation.ts').then(m=>console.log('import ok', typeof m.default)).catch(e=>{console.error('IMPORT FAIL', e.message); process.exit(1)})"
IMPORT FAIL Cannot find package '@earendil-works/pi-coding-agent' imported from /home/mariobgsp/Projects/pi-extensions/mandatory-todo-delegation.ts
```

The failure is **module resolution**, not syntax: the repo has no `node_modules` (pi injects
`typebox` / `@earendil-works/pi-coding-agent` at load; the pre-existing `decide.ts`,
`vision-handoff.ts`, `browser-auto` import the same specifiers the same way). Node had already
parsed the file and stripped its types before attempting resolution — an unresolvable specifier
proves the syntax parsed. Full runtime proof is section 3 (fake-pi harness), which supplies the
two stub packages.

## 2. Probe alone (`ui_probe.py` contract: one JSON object on stdout)

```console
$ python3.14 /home/mariobgsp/Projects/pi-extensions/ui_probe.py --spec /tmp/verify-sample/.pi/verify/probe-spec.json > /tmp/probe_out.json 2>/tmp/probe_err.txt
$ echo $?
0
$ wc -l < /tmp/probe_out.json
1
$ python3 -c "import json;d=json.load(open('/tmp/probe_out.json'));print(d['status'],[ (p['route'],p['status'],p['httpStatus'],p['pageErrors'],p['missingText'],p['clicks'],p['screenshot']) for p in d['pages']])"
status FAIL
/          FAIL 200 ['x is not defined'] ['Recent items'] [{'target': 'Boom', 'result': 'error', 'detail': 'x is not defined'}] .pi/verify/shots/root.png
/missing-page FAIL 404 [] [] [] .pi/verify/shots/missing-page-error.png
$ cat /tmp/probe_err.txt     # empty: no traceback, no diagnostics on stdout
```

Playwright 1.62 confirms: `page.page_errors()`/`console_messages()` exist, `page.accessibility`
does **not** (the old API is gone), `aria_snapshot()` works. The probe uses event listeners plus
`aria_snapshot()` and never touches `page.accessibility` or `~/.cache/pi-browser`.

## 3. Fake-pi harness — 66/66 assertions

The harness imports a copy of the module with stub `typebox` + stub
`@earendil-works/pi-coding-agent`, captures every tool/command/event registration, and drives the
real handlers. It therefore exercises the real code path without `/reload`.

```console
$ cd /tmp/verify-harness && node run.mjs
… 66 assertions …
66 passed, 0 failed        # exit 0
```

Full output: `/tmp/harness_run.txt` (kept until the fixture is deleted; the fixtures and the
harness are reproduced in section 6).

### 3.1 Wave wiring

```text
PASS  crew_dispatch {wave:verify} returns crew_verify text
PASS  crew_dispatch {wave:verify} emits no fake subagent
PASS  crew_dispatch {wave:verify} roles = []
PASS  crew_dispatch {wave:verify} keeps details keys
PASS  crew_dispatch verify has no 'Max 4 parallel' tail
PASS  crew_dispatch scout wave unchanged
PASS  before_agent_start sets sections.project_verify
PASS  before_agent_start fallback shape when no sections
PASS  cheatsheet has the Verify section
PASS  crew_open checklist names crew_verify
```

### 3.2 Full run against the throwaway sample app — per-dimension results

Sample (`/tmp/verify-sample`): `npm test` = `node --test test/unit.test.js` with one passing and
one failing assertion; `server.js` on 127.0.0.1:39517 serving `/` (h1 Items + a button whose
onclick throws `x is not defined`) and `/api/items` (200 `{"items":[]}`), everything else 404.

Observed `crew_verify` output (raw, from the harness):

```text
crew_verify: FAIL (4s) — iteration 1/3 — report: /tmp/verify-sample/.pi/verify/latest.json
project: /tmp/verify-sample
target: http://127.0.0.1:39517 (param.url; server not started by crew_verify)
fingerprint: sha256:3747bcad…[+56 chars] (9 sources newer than the last report)
DIMENSION  STATUS  REASON
unit       FAIL    1/1 checks failed
api        FAIL    1/2 checks failed
ui         FAIL    0/2 routes clean — /: pageerror+missing text+click; /missing-page: document status+http error
visual     FAIL    1/1 route verdicts failed
overall: FAIL (enabled: unit, api, ui, visual; waived: none)
NEXT (fix, then re-run crew_verify; max 3 cycles, then escalate to the user):
1. [unit/blocker] npm test — Fix npm test: npm test exit=1 (evidence: > verify-sample@1.0.0 test
> node --test test/unit.test.js
✔ passes (1.658537ms)
✖ fails on purpose (1.747435ms)
ℹ tests 2 … ℹ pass 1 … ℹ fail 1 …)
2. [api/blocker] GET http://127.0.0.1:39517/api/nope -> 200 — … status 404 (expected 200) (evidence: <h1>404</h1>)
3. [ui/blocker] / — Fix /: pageerror x is not defined; missing text: Recent items; 1 click error(s) (evidence: {"route":"/","status":"FAIL","httpStatus":200,…)
4. [ui/blocker] /missing-page — Fix /missing-page: status 404; 1 http error(s) (evidence: {"route":"/missing-page","status":"FAIL","httpStatus":404,…)
5. [visual/blocker] / — Fix /: fail: a header titled Items: Items (evidence: [{"severity":"blocker",…}] | .pi/verify/shots/root.png)
HANDOFF: reviewer reads the report + the diff; advisor/synthesizer consume these severities. Artifacts: /tmp/verify-sample/.pi/verify/ (4 file(s))
Full report (machine-readable): /tmp/verify-sample/.pi/verify/latest.json — this text shows 5 of 5 nextActions.
```

Each intended failure is caught, with evidence:

| Intended failure | Observed |
|---|---|
| failing unit test | `unit FAIL`, evidence `exitCode:1`, tail contains `AssertionError [ERR_ASSERTION]: 1 == 2` (node:test renders the assertion as `==`, not `!==`) and `✖ fails on purpose` |
| 404 endpoint declared as `expectStatus: 200` | `api FAIL`, item `GET …/api/nope -> 200` reason `status 404 (expected 200)` |
| broken button (`onclick` throws) | `ui FAIL` on `/`, pageErrors `["x is not defined"]`, click recorded as `{"result":"error","detail":"x is not defined"}` |
| absent expected text | `ui FAIL` on `/`, `missingText: ["Recent items"]` |
| 4xx route | `ui FAIL` on `/missing-page`, `httpStatus: 404` caught by `response` (not `requestfailed`) |
| visual mismatch | `visual FAIL` with stub judge verdict `fail` + defect list + shot `.pi/verify/shots/root.png` |
| screenshots | `.pi/verify/shots/{root,root-error,missing-page,missing-page-error}.png` (4 artifacts) |

Report-level assertions:

```text
PASS  run1 iteration 1
PASS  run1 report written
PASS  report unit evidence exit=1 with the assertion tail
PASS  report api evidence status 404
PASS  report ui evidence pageerror x is not defined
PASS  report ui shot present under shots/
PASS  report overall FAIL, verifyComplete false
PASS  report nextActions non-empty
PASS  report has no start.env secrets
```

### 3.3 Bounded loop, guard state, and the visual never-PASS rules

```text
PASS  visual SKIP when judge returns unclear
PASS  visual SKIP reason names unclear
PASS  visual SKIP with no vision model
PASS  visual-only run cannot be overall PASS
PASS  guard: first scout single passes
PASS  guard: second same-family single blocks
PASS  report iteration increments while not PASS
PASS  guard still blocks after crew_verify (state untouched)
PASS  guard untouched: no iteration side effect from tool_call
PASS  iteration grows past 3 and escalates
PASS  escalated text tells the agent to stop
```

The guard sequence is the important one: two bare `scout` singles block, `crew_verify` runs
between them, and the next bare `scout` single **still blocks** — the serial-dispatch state
machine (`lastSingleAt` / `lastSingleFamily`) is untouched.

### 3.4 Soft gate (crew_close / agent_end) and waivers

```text
PASS  crew_close text carries WARN:
PASS  crew_close has no blocked key
PASS  crew_close details.verify present
PASS  crew_close survives a missing ctx
PASS  crew_close no-todos gate still blocks
PASS  crew_close incomplete-todos gate still blocks
PASS  agent_end warns stale after a source change
PASS  agent_end status reflects staleness
PASS  agent_end never returns a block shape
PASS  agent_end warns when the report is missing
PASS  agent_end ignores non-tui ctx
PASS  session_shutdown handler registered + safe
PASS  sourceFingerprint changes after touching a source file
PASS  first fingerprint was also a sha256
PASS  waived dim is SKIP with the waiver reason
PASS  waiver recorded in the report
PASS  waived visual does not force PASS while unit fails
PASS  crew_close warns on a fresh FAIL report
PASS  crew_close stays unblocked on a FAIL report
PASS  crew_close reports stale when sources moved after the report
```

The two pre-existing `blocked:true` branches still block; the verify check only ever adds
`WARN:` text plus `details.verify`.

## 4. False-PASS falsification (each observed status ∈ {SKIP, FAIL})

```text
PASS  C1 unreachable URL => ui SKIP, never PASS          # url http://127.0.0.1:9/, start:false
PASS  C1 reason names unreachable
PASS  C2 (project with no test script) unit SKIP, never PASS
PASS  C2 reason lists what was searched                  # "…searched: package.json scripts.test:unit, …"
PASS  C3 malformed config => FAIL with all dims SKIP, never PASS
PASS  C4 config path escaping root is refused (FAIL, not silent defaults)
PASS  C5 missing project_root => FAIL
PASS  C6 unknown dimension => FAIL
PASS  C7 no python on PATH => ui SKIP naming the cause, never PASS
```

C7 detail: with `PATH=/nonexistent`, `runProbe` cannot spawn `python3.14` nor the `python3`
fallback, and reports
`cannot run the ui probe (missing python3.14/python3?): spawn error: spawn python3.14 ENOENT` —
a SKIP with the cause, never a pass. No dimension that failed to execute can produce
`overall: PASS`; the showcase run above (`overall: FAIL`) is the end-to-end proof.

## 5. Not verifiable without a live pi session

Stated plainly rather than assumed:

- the real `before_agent_start` system-prompt assembly (the shape is confirmed against
  `pi/docs/extensions.md:530-568` and `examples/extensions/prompt-customizer.ts`, which mutate
  `event.systemPromptOptions.sections` — exactly the branch the harness exercised);
- the `agent_end` TUI toast/status rendering (`ctx.mode === "tui"` gate exercised; the actual
  toast is TUI-only);
- `/reload` activation and `ctx.isProjectTrusted()`;
- whether the real `modelRegistry.complete` accepts the image message shape / the `temperature`
  option (the call is copied from `vision-handoff.ts:316-355`; a rejected `temperature` falls
  back to a second call without it, and any failure ⇒ `unclear` ⇒ `SKIP`, never PASS);
- the real registry resolving `~/.pi/agent/vision-model.json` (the harness stubs `find`/auth).

Also unverified: real dev-server auto-start (`config.start`) — the sample used `start:false`
with a manually started server; `startDevServer` is the only path not driven end-to-end in this
run, and it is the one place where the process-group kill matters most.

## 6. Re-running the fixture

Deleted after the run (throwaway, `/tmp` only):

- `/tmp/verify-sample/{package.json,server.js,index.html,test/unit.test.js,.pi/verify.json}`
  — the app above; start with `node server.js &` (port 39517).
- `/tmp/verify-harness/{mandatory-todo-delegation.ts,ui_probe.py,run.mjs,node_modules/*}` — copy
  the two real files in, stub `typebox` (`Type.*` → `()=>({})`) and
  `@earendil-works/pi-coding-agent` (`isToolCallEventType = (n,e)=>e?.type===n`), then
  `node run.mjs`.

## Fix round 1 (false-PASS closure) — raw commands + observed output

Round 1 closes an independent review of the delivered enhancement. Backup of the reviewed
revision (outside the repo):

```console
$ cp -p mandatory-todo-delegation.ts /tmp/verify-fix-baseline-20260921-211216.ts   # md5 2fd06a8bae305939d4bd5e6051368a1f
$ cp -p ui_probe.py                /tmp/verify-fix-baseline-20260921-211216.py   # md5 2377523ddd9c00478fa3606e5fa846d7
$ cp -p VERIFY.md                  /tmp/verify-fix-baseline-20260921-211216.VERIFY.md
$ md5sum mandatory-todo-delegation.ts ui_probe.py VERIFY.md        # fixed revision
45ed58664e2ca205cee56db5d10b3305  mandatory-todo-delegation.ts
897c1879a567d3b1d78ea70e53b2d6ea  ui_probe.py
2c07164d6db3468ecc5031d34da5ab95  VERIFY.md
```

Harness (same technique as the review, rebuilt from scratch at `/tmp/fixproof`): the real
module is copied into `/tmp/fixproof/ext/` with stub `typebox` (`Type.*` → `()=>({})`) and
`@earendil-works/pi-coding-agent` (`isToolCallEventType = (n,e)=>e?.type===n`), the real
`ui_probe.py` is copied beside it (so `probeScriptPath()` runs the shipped probe), and
`proof.mjs` drives `crew_verify`/`crew_close`/`agent_end` in-process. Two sample HTTP servers
(`node apps/serve.mjs`, one of them logging every request) back the ui scenarios.

```console
$ cp /tmp/verify-fix-baseline-20260921-211216.ts /tmp/fixproof/ext/mandatory-todo-delegation.ts
$ cp /tmp/verify-fix-baseline-20260921-211216.py /tmp/fixproof/ext/ui_probe.py
$ cd /tmp/fixproof && node proof.mjs --edition=before | tee before.txt      # reviewed revision
$ cp /home/mariobgsp/Projects/pi-extensions/{mandatory-todo-delegation.ts,ui_probe.py} /tmp/fixproof/ext/
$ node proof.mjs --edition=after | tee after.txt                            # fixed revision
```

### Proof 1 — unit: `"test": "true"` (exit 0, no tests)

```console
# before
[S1] overall=SKIP unit=PASS | 1/1 checks passed
[S1] item=[["PASS","npm test exit=0"]]
[S1] nextActions=[]
# after
[S1] overall=SKIP unit=SKIP | 1/1 checks did not run or warned: npm test (exit 0 but no test count reported)
[S1] nextActions=[["unit","major","No evidence for unit: 1/1 checks did not run or warned: npm test (exit"]]
```

### Proof 2 — unit: `Tests: 10 passed, 10 total` must not read as "ran no tests" (m1)

```console
# before  (unanchored /0 (tests? )?passed/ matched inside "10 passed")
[S2] overall=SKIP unit=SKIP | runner ran no tests (exit=0, no test count)
# after
[S2] overall=PASS unit=PASS | 1/1 checks passed
```

### Proof 3 — ui: 25 routes, small `timeout_ms` (B3)

```console
# before: PASS computed from the 13 pages collected before the clock ran out
[S3] overall=SKIP ui=PASS | 13/13 routes clean
[S3] ui items=13 (routes probed) of 25 requested
# after
[S3] overall=SKIP ui=SKIP | deadline: 7/25 routes probed
[S3] ui items=7 (routes probed) of 25 requested
```

### Proof 4 — scoped `dimensions:["api"]` (B4)

```console
# before: api PASS, overall SKIP, matrix claims every dim is enabled
[S4] overall=SKIP
[S4] matrix: overall: SKIP (enabled: unit, api, ui, visual; waived: none)
[S4] dimensions=[["unit",true,"SKIP"],["api",true,"PASS"],["ui",true,"SKIP"],["visual",true,"SKIP"]]
# after
[S4] overall=PASS
[S4] matrix: overall: PASS (enabled: api; waived: none)
[S4] dimensions=[["unit",false,"SKIP"],["api",true,"PASS"],["ui",false,"SKIP"],["visual",false,"SKIP"]]
```

### Proof 5 — budget starvation (B2)

```console
# before: second command never spawned, dimension still PASS
[S5] overall=SKIP unit=PASS | 1/2 checks passed
[S5] second command executed? marker exists = false
# after: reason names the check that did not run
[S5] overall=SKIP unit=SKIP | 1/2 checks did not run or warned: node -e require("fs").writeFileSync("/tmp/fixproof/apps/budget/second-ran.txt","yes");console.log("# pass 2") (budget exhausted)
[S5] second command executed? marker exists = false
```

### Proof 6 — destructive sweep: `<form action="/purge" method="post">` + `<button>Clear all</button>` (M1, M6)

Sample page served from `/tmp/fixproof/apps/destructive/index.html`; the server appends every
request to `requests.log`.

```console
# before: the form was submitted twice and "Clear all" was clicked
[S6] probe status=FAIL clicks=[{"target":"Confirm","result":"dead-click",...},{"target":"Clear all","result":"dead-click",...},{"target":"Refresh","result":"dead-click",...}] destructiveSkips=undefined
[S6] probe artifacts=[".pi/verify/shots/root.png",".pi/verify/shots/root-error.png"]
[S6] server log: POST /purge count = 2
[S6] server log lines = ["GET /","POST /purge","GET /","GET /","GET /","GET /"]
# after: both refused, counted, and no -error.png artifact
[S6] probe status=FAIL clicks=[{"target":"Confirm","result":"skipped","detail":"destructive form (post /purge)"},{"target":"Clear all","result":"skipped","detail":"destructive-looking"},{"target":"Refresh","result":"dead-click","detail":"url unchanged, 0 mutations, no dialog, no popup"}] destructiveSkips=2
[S6] probe artifacts=[".pi/verify/shots/root.png"]
[S6] server log: POST /purge count = 0
[S6] server log lines = ["GET /","GET /","GET /","GET /","GET /","GET /"]
```

The dropped `-error.png` was byte-identical to the clean shot (md5 42c4288… for both) because
it was taken after the sweep re-navigated; round 1 removes the artifact entirely.

### Proof 7 — console-only failure: caught throw + `console.error` (M2)

```console
# before: probe reports the page clean, crew_verify PASSes the dimension, no actions
[S7] probe page status=PASS failSignals=[] consoleErrors=["boom: Cannot read properties of null (reading 'x')"]
[S7] crew_verify overall=SKIP ui=PASS | 1/1 routes clean
[S7] ui items=[["PASS","clean (no fail signal)"],["WARN","1 console error(s): boom: ..."]]
[S7] nextActions=[]
# after: the console error is a FAIL item, is named in the dimension reason, and produces an action
[S7] crew_verify overall=FAIL ui=FAIL | 0/1 routes clean — 1 console error(s) — /: console/cross-origin noise
[S7] ui items=[["PASS","1 console error(s)"],["FAIL","1 console error(s): boom: Cannot read properties of null (reading 'x')"]]
[S7] nextActions=[["blocker","Fix / (console): 1 console error(s): boom: Cannot read properties of null (readi"]]
```

### Proof 8 — declared-but-unavailable visual reference (M5)

```console
# before: both references silently dropped, both routes PASS
[S8] overall=SKIP visual=PASS | 2/2 route verdicts passed
[S8] visual items=[["/","PASS","pass: verdict pass"],["/esc","PASS","pass: verdict pass"]]
[S8] report.visualUpload=undefined
[S8] uploadOk:false -> visual=PASS | 2/2 route verdicts passed
# after
[S8] overall=SKIP visual=SKIP | judge returned unclear (no evidence) for 2 route(s)
[S8] visual items=[["/","SKIP","reference unavailable: .pi/verify/refs/missing.png"],["/esc","SKIP","reference unavailable: ../../etc/passwd"]]
[S8] report.visualUpload={"model":"openrouter/google/gemma-4-26b-a4b-it:free","via":"configured","uploadOk":true}
[S8] upload nextAction=[["major","Screenshots were uploaded to openrouter/google/gemma-4-26b-a4b-it:free (picked via configu"],["major","No evidence for visual: judge returned unclear (no evidence) for 2 route(s)"]]
[S8] uploadOk:false -> visual=SKIP | visual.uploadOk=false — screenshots are not uploaded off-machine, so no verdict
[S8] uploadOk:false visual items=[] visualUpload=null
```

The judge itself is stubbed (`modelRegistry.complete` returns a JSON `verdict: "pass"`), so
this proves the routing/refusal logic, **not** the vision path.

### Extra closures (S9–S13)

```console
# S9 cross-origin requestfailure (M3): dead backend on :39599, console noise ignored
# before
[S9] requestFailed=[] crossOriginFailures=undefined
[S9] crew_verify overall=SKIP ui=PASS | 1/1 routes clean
[S9] nextActions=[]
# after
[S9] requestFailed=[] crossOriginFailures=[["http://127.0.0.1:39599/health","net::ERR_CONNECTION_REFUSED"]]
[S9] crew_verify overall=SKIP ui=SKIP | 0/1 routes clean — 1/2 checks did not run or warned: / (cross-origin request failed) (1 cross-origin request(s) failed: http://127.0.0.1:39599/health (net::ERR_…
[S9] nextActions=[["major","Investigate / (cross-origin request failed): ..."],["major","No evidence for ui: ..."]]

# S10 tokens in api.endpoints[].url / unit.commands[].args / evidence tail (m4)
# before
[S10] report contains SECRET123=true SECRET456=true <redacted>=false
[S10] configUsed.api.endpoints[0].url=http://127.0.0.1:39532/api/items?token=SECRET123
[S10] unit item outputTail="token=SECRET456\n# pass 1"
# after
[S10] report contains SECRET123=false SECRET456=false <redacted>=true
[S10] configUsed.api.endpoints[0].url=http://127.0.0.1:39532/api/items?token=<redacted>
[S10] unit item outputTail="token=<redacted>\n# pass 1"

# S11 verify {project_root:X} then crew_close from another cwd (m9)
# before
[S11] crew_close(ui.notify not wired) verify details={"status":"missing"}
[S11] crew_close text warnings=["WARN: no verification report (.pi/verify/latest.json). Run crew_verify before claiming done — evidence required, absence is not a pass."]
# after
[S11] crew_close(ui.notify not wired) verify details={"status":"pass","overall":"PASS","reportPath":"/tmp/fixproof/apps/m9/.pi/verify/latest.json"}
[S11] crew_close text warnings=[]

# S12 agent_end on a fresh FAIL report (m10)
# before
[S12] agent_end notify=[]
# after
[S12] agent_end notify=[["warning","crew_verify: verification overall FAIL — 1 open item(s). Fix and re-run crew_verify (max 3 cycles)."]]

# S13 escalated header (m11), 4 cycles on the same project
# before
[S13] header="crew_verify: FAIL (0s) — iteration 4/3 — report: ..."
[S13] details.iteration=4 escalated=true
# after
[S13] header="crew_verify: FAIL (0s) — iteration 3/3 — report: ..."
[S13] details.iteration=4 escalated=true
```

No orphan processes after the runs (`pgrep -af "serve.mjs|ui_probe.py"` empty, `ss -ltn` shows
no listener on 39531-39536, `node proof.mjs` gone). Process-group kills from the extension
itself were already covered in section 4.

### Round-1 honesty notes

- `proof.mjs --edition=before` needed `timeout_ms: 8000` for the 25-route sample to *complete*
  and exhibit the reviewer's exact false PASS (`13/13 routes clean`, 12 routes never visited).
  At `timeout_ms: 6000` the reviewed revision killed its own probe (`probe timed out after
  5980ms`) — also not a PASS, but the false-PASS shape only appears when the probe gets to
  print. The fix makes the deadline path deterministic instead of timing-dependent: the TS now
  gives the probe a kill timeout beyond the probe's own deadline (`probeDeadlineMs + 4000`,
  deadline `remaining() - 2500`) and the probe refuses to start a route it cannot finish.
- S8's vision judge is a stub; no run in this round (or before it) has ever executed the
  real `modelRegistry.complete` vision call.
- `"N tests ok"` / `"N passing"` are accepted test-count shapes (documented in VERIFY.md) but
  only `# pass N` and `N passed` have live evidence in this round.

## Fix round 2 — adversarial review closure (R1–R4, W1–W11 + docs)

Second independent review of the round-1 revision found four ship-blockers and eleven warnings.
Backup of the reviewed revision (outside the repo, taken before this round's first edit):

```console
$ cp -p mandatory-todo-delegation.ts /tmp/verify-fix2-baseline-20260921-220315.ts   # md5 45ed58664e2ca205cee56db5d10b3305
$ cp -p ui_probe.py                /tmp/verify-fix2-baseline-20260921-220315.py   # md5 897c1879a567d3b1d78ea70e53b2d6ea
$ cp -p VERIFY.md                  /tmp/verify-fix2-baseline-20260921-220315.VERIFY.md
$ md5sum mandatory-todo-delegation.ts ui_probe.py VERIFY.md        # fixed revision
5deb9c720415cab791d5805c00806805  mandatory-todo-delegation.ts
4ab5b07d71644a655ad826a39a8943c6  ui_probe.py
3aae52ac9b2343d08409bd30f3ac54c6  VERIFY.md
```

(`SELFTEST.md` changed once more while this section was written; the final revision hashes are
`5deb9c720415cab791d5805c00806805` ts, `4ab5b07d71644a655ad826a39a8943c6` py,
`d3176575acf23b692a754f58ca6d7dcc` VERIFY.md, `cfdf39befd4c2ab9845a8010d2c1d358` SELFTEST.md —
the two source files did not change after the runs below.)

**Correction (fix round 3):** the `SELFTEST.md` md5 recorded in that line was **already stale when
the note was written** — the file as it stood immediately before fix round 3 hashes
`0ac87d1af8e4e9d75d64ee26ac18149a`, not `cfdf39befd4c2ab9845a8010d2c1d358`. The two *source*
hashes on that line were correct.

Harness: rebuilt from scratch at `/tmp/fixproof2` (never touching `/tmp/fixproof`, `/tmp/rev`):
the real module + real `ui_probe.py` copied into `/tmp/fixproof2/ext/` beside stub `typebox` and
stub `@earendil-works/pi-coding-agent`, a fixture HTTP server (`apps/serve.mjs`, logs every
request, `/hold` never answers) and a stub `modelRegistry`. `proof.mjs` drives the real
`crew_verify`/`crew_close`/`crew_dispatch`/guard handlers.

```console
$ cp /tmp/verify-fix2-baseline-20260921-220315.{ts,py} /tmp/fixproof2/ext/
$ cd /tmp/fixproof2 && node proof.mjs --edition=before > before.txt 2>&1    # reviewed revision
$ cp /home/mariobgsp/Projects/pi-extensions/{mandatory-todo-delegation.ts,ui_probe.py} /tmp/fixproof2/ext/
$ node proof.mjs --edition=after > after.txt 2>&1                          # fixed revision
```

Every line below is a `printf`-exact copy of `before.txt` / `after.txt`; `[id]` is the scenario
tag the harness prints.

### Proof 1 — R1 unit: exit-0 failure counts must never PASS, and the count shapes must not SKIP

```console
# R1-1  exit 0, output "3 passed, 1 failed"
# before
[R1-1] unit=PASS | 1/1 checks passed
[R1-1] item=[["PASS","node -e console.log('3 passed, 1 failed') exit=0 — 3 passed, 1 failed"]]
# after
[R1-1] unit=FAIL | 1/1 checks failed
[R1-1] item=[["FAIL","node -e console.log('3 passed, 1 failed') exit=0 but the runner reported failures — 3 passed, 1 failed"]]

# R1-2 "1 failed, 1 passed" | R1-3 "1 failing, 2 passing" | R1-4 jest "Tests: 1 failed, 1 passed, 2 total"
# before: all three PASS ("… exit=0 — 1 passed, 1 failed" / "— 2 tests" / "— 1 passed, 1 failed")
[R1-2] unit=PASS | 1/1 checks passed
[R1-3] unit=PASS | 1/1 checks passed
[R1-4] unit=PASS | 1/1 checks passed
# after: all three FAIL
[R1-2] unit=FAIL | 1/1 checks failed
[R1-3] unit=FAIL | 1/1 checks failed
[R1-4] unit=FAIL | 1/1 checks failed

# R1-5 "ok  example.com/app  0.004s" (go, non-verbose)
# before
[R1-5] unit=SKIP | 1/1 checks did not run or warned: node -e console.log('ok  example.com/app  0.004s') (exit 0 but no test count reported)
[R1-5] item=[["SKIP","exit 0 but no test count reported"]]
# after
[R1-5] unit=PASS | 1/1 checks passed
[R1-5] item=[["PASS","node -e console.log('ok  example.com/app  0.004s') exit=0 — 1 passed"]]

# R1-6 phpunit "OK (10 tests, 10 assertions)"   # R1-7 rspec "10 examples, 0 failures"
# before: both SKIP "exit 0 but no test count reported"
# after: both PASS "… exit=0 — 10 passed"

# R1-8 "10 passing"   # R1-9 "10 tests ok"   (already accepted counts, must stay PASS)
# before: PASS "— 10 tests"      # after: PASS "— 10 passed"
[R1-8] unit=PASS | 1/1 checks passed
[R1-9] unit=PASS | 1/1 checks passed

# R1-10 pytest "# pass 10"  # R1-11 jest "Tests: 10 passed, 10 total"  ↓ benign controls, unchanged
[R1-10] unit=PASS | 1/1 checks passed
[R1-11] unit=PASS | 1/1 checks passed
[R1-12] unit=PASS | 1/1 checks passed        # npm test detection, item [["npm test","PASS","npm test exit=0 — 10 passed"]]
```

Note the benign half of R1: the always-PASS shapes stayed PASS and nothing became SKIP — the
stricter failure rule did not turn healthy suites noisy.

### Proof 2 — R2 an api-only run against absolute endpoints never silently SKIPs

Nothing listens on `http://localhost:3000` in any of these runs (the probes below are the only
servers alive, on 127.0.0.1:39651 / a dead 39652).

```console
# R2-1 {dimensions:["api"]}, endpoint http://127.0.0.1:39651/api/items -> 200
# before
[R2-1] api=SKIP | unreachable: http://localhost:3000 (fetch failed)
[R2-1] item=[]
[R2-1] overall: SKIP (enabled: api; waived: none) overall=SKIP
# after
[R2-1] api=PASS | 1/1 checks passed
[R2-1] item=[["GET http://127.0.0.1:39651/api/items -> 200","PASS","200 in 7ms"]]
[R2-1] overall: PASS (enabled: api; waived: none) overall=PASS

# R2-2 same but /api/boom declared expectStatus 200 => api-only FAIL must be overall FAIL
# before
[R2-2] api=SKIP | unreachable: http://localhost:3000 (fetch failed)
[R2-2] overall: SKIP (enabled: api; waived: none) overall=SKIP
[R2-2] next=[["api","major","api dimension"]]
# after
[R2-2] api=FAIL | 1/1 checks failed
[R2-2] overall: FAIL (enabled: api; waived: none) overall=FAIL
[R2-2] next=[["api","blocker","GET http://127.0.0.1:39651/api/boom -> 200"]]

# R2-3 mixed absolute + relative: the absolute one is probed, the relative one SKIPs (no base)
# before: api=SKIP item=[]              # after:
[R2-3] items=[["GET http://127.0.0.1:39651/api/items -> 200","PASS","200 in 1ms"],["/api/items","SKIP","relative endpoint needs a reachable base url: unreachable: http://localhost:3000 (fetch failed)"]]
[R2-3] api=SKIP | 1/2 checks did not run or warned: /api/items (relative endpoint needs a reachable base url: unreachable: http://localhost:3000…[+15 chars])
```

### Proof 3 — R3 the JS-driven destructive control is never clicked

Fixture `apps/ui/destructive.html`: `Cancel order` and `Confirm changes` both
`onclick="fetch('/orders/42/cancel',{method:'POST'})"`, `Apply now` is `hx-post="/orders/42/cancel"`,
`Save note` is benign. The server logs every request.

```console
# before
[R3-1] probe status=FAIL failSignals=["click"] destructiveSkips=0
[R3-1] clicks=[{"target":"Cancel order","result":"dead-click",…},{"target":"Confirm changes","result":"dead-click",…},{"target":"Apply now","result":"dead-click",…},{"target":"Save note","result":"changed","detail":"url/mutations=1"}]
[R3-1] server log: POST count=2 lines=["GET /destructive.html","POST /orders/42/cancel","GET /","GET /destructive.html","POST /orders/42/cancel","GET /","GET /destructive.html","GET /destructive.html","GET /destructive.html"]
# after
[R3-1] probe status=PASS failSignals=[] destructiveSkips=3
[R3-1] clicks=[{"target":"Cancel order","result":"skipped","detail":"destructive-looking (destructive label)"},{"target":"Confirm changes","result":"skipped","detail":"destructive-looking (onclick writes (POST/PUT/PATCH/DELETE))"},{"target":"Apply now","result":"skipped","detail":"destructive-looking (hx-post is a write)"},{"target":"Save note","result":"changed","detail":"url/mutations=1"}]
[R3-1] server log: POST count=0 lines=["GET /destructive.html","GET /destructive.html"]
```

`Confirm changes` has a *neutral* label — it is refused by the inline-handler analysis, not by the
label list. The escape knobs (R3):

```console
# before (unknown spec keys ignored -> sweep still runs)
[R3-2] clickSkipRoutes: status=FAIL clicks=[…] POST count=2
[R3-2] clickAllow['Cancel order']: destructiveSkips=0 POST count=2
# after
[R3-2] clickSkipRoutes: status=PASS clicks=[] POST count=0
[R3-2] clickAllow['Cancel order']: destructiveSkips=2 POST count=1
[R3-2] clicks=[["Cancel order","inert"],["Confirm changes","skipped"],["Apply now","skipped"],["Save note","changed"]]
```

### Proof 4 — R4 no SECRET_* in the returned text or `latest.json`

Run A: `target.url=http://127.0.0.1:39651/?token=SECRET_E`, start args `--api-key SECRET_A`,
unit args `… --password SECRET_C`, api endpoint `?token=SECRET_D`.
Run B: cross-origin failure to `http://127.0.0.1:39652/health?token=SECRET123`.

```console
# R4-1 before
[R4-1] SECRET_* in report or tool text: ["SECRET_E","SECRET_A","SECRET_C"]
[R4-1] target.url=http://127.0.0.1:39651/?token=SECRET_E
[R4-1] target.startCommand=node -e console.log(1) --api-key SECRET_A
[R4-1] configUsed.unit.args=["-e","console.log('token=<redacted>');console.log('# pass 2')","--","--password","SECRET_C"]
[R4-1] unit evidence.command=node -e console.log('token=<redacted>');console.log('# pass 2') -- --password SECRET_C
[R4-1] toolText has token=SECRET/redacted: SECRET=true redacted=false
# R4-1 after
[R4-1] SECRET_* in report or tool text: []
[R4-1] target.url=http://127.0.0.1:39651/?token=<redacted>
[R4-1] target.startCommand=node -e console.log(1) --api-key <redacted>
[R4-1] configUsed.unit.args=["-e","console.log('token=<redacted>');console.log('# pass 2')","--","--password","<redacted>"]
[R4-1] unit evidence.command=node -e console.log('token=<redacted>');console.log('# pass 2') -- --password <redacted>
[R4-1] toolText has token=SECRET/redacted: SECRET=false redacted=true

# R4-2 (cross-origin WARN evidence + nextActions) before
[R4-2] SECRET_* in report or tool text: ["SECRET123"]
[R4-2] tool text health line=["2. [ui/major] /xorigin.html (cross-origin request failed) — Investigate …: 1 cross-origin request(s) failed: http://127.0.0.1:39652/health?token=SECRET123 (net::ERR_CONNECTION_RE…[+6 chars] (evidence: [[\"http://127.0.0.1:39652/health?token=SECRET123\",\"net::ERR_CONNECTION_REFUSED\"]])"]
# R4-2 after
[R4-2] SECRET_* in report or tool text: []
[R4-2] item evidence=[…,"[[\"http://127.0.0.1:39652/health?token=<redacted>\",\"net::ERR_CONNECTION_REFUSED\"]]"]
[R4-2] tool text health line=["2. [ui/major] /xorigin.html (cross-origin request failed) — Investigate …: 1 cross-origin request(s) failed: http://127.0.0.1:39652/health?token=<redacted> (net::ERR_CONNECTION_R…[+7 chars] (evidence: [[\"http://127.0.0.1:39652/health?token=<redacted>\",\"net::ERR_CONNECTION_REFUSED\"]])"]
```

Both greps (`grep SECRET /tmp/…/latest.json` and the returned tool text) are empty in the after
runs; `target.*`, `configUsed`, evidence tails and `nextActions[].evidence` are all covered.

### Proof 5 — W2 `/empty.html` (200, empty root) is not clean

```console
# before
[W2-1] probe status=PASS failSignals=[] text="Empty"
[W2-1] crew_verify ui=PASS | 1/1 routes clean
[W2-1] overall: PASS (enabled: ui; waived: none)
# after
[W2-1] probe status=FAIL failSignals=["empty document"] text="Empty"
[W2-1] crew_verify ui=FAIL | 1/1 routes failed — /empty.html: empty document
[W2-1] overall: FAIL (enabled: ui; waived: none)
```

### Proof 6 — W3 the benign page clicks all safe controls, skips exactly the destructive ones

Fixture `apps/ui/benign.html`, 8 candidates: `Payments` (class `nav-pay`),
`<button aria-label="Clear filters">Search</button>`, `Next page` (class `reset-default-view`),
`Stop`, plus `Delete`, `Sign out`, `Confirm changes` (fetch POST), `Go` (hx-post).

```console
# before
[W3-1] status=FAIL failSignals=["click"] candidates=8
[W3-1] changed=[]
[W3-1] skipped=["Payments","Search","Next page","Stop","Delete","Sign out"] (destructiveSkips=6)
[W3-1] server log: POST count=1
# after
[W3-1] status=PASS failSignals=[] candidates=8
[W3-1] changed=["Payments","Search Clear filters","Next page","Stop"]
[W3-1] skipped=["Delete","Sign out","Confirm changes","Go"] (destructiveSkips=4)
[W3-1] server log: POST count=0
```

8 candidates: 4 clicked (not 0), 4 skipped, and the 2 remaining destructive ones are the fetch-POST
and htmx controls that the round-1 HTML substring match could not see.

### Proof 7 — W4/W5 dead clicks on inert controls, and overflow that keeps a verdict

```console
# W4-1 /inert.html = <button>Cancel</button><button>Close</button>, no dialog
# before
[W4-1] probe status=FAIL failSignals=["click"] inertClicks=undefined
[W4-1] clicks=[{"target":"Cancel","result":"dead-click",…},{"target":"Close","result":"dead-click",…}]
# after
[W4-1] probe status=PASS failSignals=[] inertClicks=2
[W4-1] clicks=[{"target":"Cancel","result":"inert","detail":"url unchanged, 0 mutations; label is inert in most states"},{"target":"Close","result":"inert","…"}]

# W4-2 no over-correction: <button>Submit</button> that really does nothing still FAILs
[W4-2] probe status=FAIL failSignals=["click"]      # before AND after

# W5-1 /overflow.html, 2728px of horizontal overflow
# before
[W5-1] probe overflowX=2728 status=PASS
[W5-1] crew_verify ui=SKIP | 1/1 routes clean — 1/2 checks did not run or warned: /overflow.html (overflow) (horizontal overflow 2728px)
[W5-1] overall: SKIP (enabled: ui; waived: none) overall=SKIP
# after
[W5-1] crew_verify ui=PASS | 1/1 routes clean
[W5-1] items=[["/overflow.html","PASS","clean (no fail signal)"],["/overflow.html (overflow)","WARN","horizontal overflow 2728px"]]
[W5-1] overall: PASS (enabled: ui; waived: none) overall=PASS
[W5-1] next=[["ui","major","/overflow.html (overflow)"]]
```

### Proof 8 — W6/W7/W10 FailReport honesty, PASS runs without unfixable majors, verdict edges

```console
# W6-1 {dimensions:["api","bogus"]}
# before
[W6-1] overall=FAIL overall: FAIL (enabled: unit, api, ui, visual; waived: none)
[W6-1] dims=[["unit",true,"SKIP"],["api",true,"SKIP"],["ui",true,"SKIP"],["visual",true,"SKIP"]]
[W6-1] nextActions=0 []
[W6-1] last text line=["NEXT: none — no failing evidence."]
# after
[W6-1] overall=FAIL overall: FAIL (enabled: api; waived: none)
[W6-1] dims=[["unit",false,"SKIP"],["api",true,"SKIP"],["ui",false,"SKIP"],["visual",false,"SKIP"]]
[W6-1] nextActions=1 [["api","blocker"]]
[W6-1] last text line=["1. [api/blocker] crew_verify — unknown dimension(s): bogus (valid: unit, api, ui, visual) (evidence: unknown dimension(s): bogus (valid: unit, api, ui, visual))"]

# W7-1 unit PASS + visual waived
# before: overall=PASS verifyComplete=true with one unfixable major
[W7-1] nextActions=1 [{"dimension":"visual","severity":"major","target":"visual dimension","action":"No evidence for visual: waived: no vision model in this environment",…}]
# after
[W7-1] overall=PASS overall: PASS (enabled: unit, visual; waived: visual)
[W7-1] nextActions=0 []
[W7-1] verifyComplete=true dims=[["unit","PASS","1/1 checks passed"],…,["visual","SKIP","waived: no vision model in this environment"]]

# W8-1 the disclosure is "info" and carries the real call count
# before
[W8-1] registry calls=1 visualUpload={"model":"stub/vision","via":"configured","uploadOk":true}
[W8-1] next=[["major","Screenshots were uploaded to stub/vision (picked via configured) to judge the routes — pin"]]
# after
[W8-1] registry calls=1 visualUpload={"model":"stub/vision","via":"configured","uploadOk":true,"judgeCalls":1}
[W8-1] overall: PASS (enabled: ui, visual; waived: none)
[W8-1] next=[["info","Screenshots were uploaded to stub/vision (picked via configured) to judge 1 route(s) — pin"]]
# W8-2 no judge call (missing reference): claim what happened
# before: visualUpload={"model":"stub/vision","via":"configured","uploadOk":true} + "Screenshots were uploaded to …"
# after
[W8-2] registry calls=0 visualUpload={"model":"stub/vision","via":"configured","uploadOk":false,"judgeCalls":0}
[W8-2] next=[["info","Nothing was uploaded: stub/vision (picked via configured) was the intended judge target, but no judge call ran"],["major","No evidence for visual: judge returned unclear (no evidence) for 1 route(s)"]]

# W10-1 dimensions:[] and a single waived dim
# before: dimensions=[] -> nextActions=0 []  | single waived dim -> nextActions=1
# after
[W10-1] dimensions=[] overall=SKIP overall: SKIP (enabled: none; waived: none)
[W10-1] nextActions=1 [["unit","major","crew_verify SKIP"]]
[W10-1] single waived dim overall=SKIP overall: SKIP (enabled: visual; waived: visual)
[W10-1] nextActions=1 [["visual","major"]]
[W10-1] waived=[{"dimension":"visual","reason":"no vision model in this environment"}]

# W10-2 a waiver still does not block PASS (unchanged, both editions)
[W10-2] overall=PASS overall: PASS (enabled: unit, visual; waived: visual) verifyComplete=true

# W11-1 ui SKIP with an item-level WARN (console.html, failOnConsoleError:false)
# before: the dim-level action duplicates the item-level one
[W11-1] actions=[["ui","major","/console.html (console)"],["ui","major","ui dimension"]]
[W11-1] dim-level "No evidence for ui" present=true
# after
[W11-1] actions=[["ui","major","/console.html (console)"]]
[W11-1] dim-level "No evidence for ui" present=false
```

### Proof 9 — W9 `clickBudget: 0` reaches the probe as 0

Fixture `/many.html` has 12 benign controls; "clicks performed" counts non-skipped entries.

```console
# before (Number(0) || 8)
[W9-1] spec.clickBudget=8 (config 0)
[W9-1] probe @spec.clickBudget=8: clicks performed=8 of 12 candidates, skipped=0
[W9-1] spec.clickBudget=3 (config 3)
[W9-1] probe @spec.clickBudget=3: clicks performed=3
# after
[W9-1] spec.clickBudget=0 (config 0)
[W9-1] probe @spec.clickBudget=0: clicks performed=0 of 12 candidates, skipped=0
[W9-1] spec.clickBudget=3 (config 3)
[W9-1] probe @spec.clickBudget=3: clicks performed=3
[W9-1] probe @clickBudget=8 (default): clicks performed=8
```

### Proof 10 — W1 coverage denominators, and the regression set

```console
# W1-1 25 routes, timeout_ms 8000
# before
[W1-1] ui=SKIP | deadline: 7/25 routes probed
# after
[W1-1] ui=SKIP | 7/25 routes probed (truncated) — deadline: 7/25 routes probed
[W1-1] items=7 of 25 requested

# W1-2 same deadline, route 1 is /empty.html (an observed FAIL)
# before: FAIL downgraded to SKIP
[W1-2] ui=SKIP | deadline: 9/25 routes probed
[W1-2] overall: SKIP (enabled: ui; waived: none)
# after
[W1-2] ui=FAIL | 9/25 routes probed (truncated) — 1/9 routes failed — /empty.html: empty document
[W1-2] overall: FAIL (enabled: ui; waived: none)

# W1-3 probe killed while a route never answers (/hold)
# before: no coverage line at all
[W1-3] ui=SKIP | probe timed out after 10505ms
[W1-3] item=[["ui_probe.py","SKIP","probe timed out after 10505ms"]]
# after
[W1-3] ui=SKIP | probe timed out after 10505ms — 0/2 routes reported (2 requested)
[W1-3] item=[["ui_probe.py","SKIP","probe timed out after 10505ms — 0/2 routes reported (2 requested)"]]
```

```console
# REG-1 parses/transpiles (in the harness, with the stubs on the resolution path)
[REG-1] node strip-types exit=0 stdout="import ok"
[REG-1] py_compile exit=0 stderr=""
# (in the repo itself, without node_modules, the same command fails only on module resolution:
#  "Cannot find package '@earendil-works/pi-coding-agent'" — unchanged from round 1)

# REG-2 dispatcher guard: 2nd same-family single blocked, runs.all + lone roles pass
[REG-2] first scout blocked=false second scout blocked=true runs.all blocked=false builder blocked=false
# REG-3 serial Herdr prompt: 2nd blocked, backgrounded never blocked
[REG-3] 1st serial blocked=false 2nd serial blocked=true backgrounded blocked=false
[REG-3] block reason="Blocked serial Herdr prompt — background each 'prompt --wait --timeout 300000' in ONE bash"
# REG-4 verify wave
[REG-4] roles=[] parallel=false mode=herdr
# REG-5 crew_close blocked branches
[REG-5] no-todos blocked=true reason=no-todos
[REG-5] incomplete blocked=true reason=incomplete-todos 1/3
# REG-6 dev-server group kill reaps a grandchild
[REG-6] serverStartedByVerify=true startCommand=bash -c sleep 300 & echo $! > gc.pid; wait
[REG-6] grandchild pid=163367 alive after verify=false
[REG-6] overall: PASS (enabled: unit; waived: none)
```

No orphan processes after either full run: `pgrep -af "serve.mjs|ui_probe.py|proof.mjs"` is empty and
`ss -ltn` shows no listener on 39651/39652 (the fixture server is killed by `proof.mjs` on exit and
by the group-kill assertion in REG-6).

### Round-2 honesty notes

- **Doc mismatches corrected in VERIFY.md** (all four the reviewer named): the derived-verdict block
  no longer claims an enabled dimension with "no evidence" is a FAIL (it is a SKIP ⇒ `overall: SKIP`);
  the `unit` row now says what `go test ./...` really prints (one `ok <pkg>` line, i.e. a *package*
  count, and no test count in non-verbose output); the vision picker order is documented as
  implemented (`visual.model` → `~/.pi/agent/vision-model.json` → session model → first available),
  with a note that `via: "current"/"fallback"` are dead once a default file exists; `ignoreConsole`
  is documented as **unanchored case-insensitive substrings** (so `["error"]` hides real
  `console.error`s). Overflow keeping the `ui` verdict, the new `clickBudget:0` /
  `clickSkipRoutes` / `clickAllow` keys, the deep secret scrub, the empty-document rule and the
  `info`-severity upload disclosure are documented too.
- **Ceiling kept in the code, not papered over**: the destructive click check is *static*. A
  handler attached via `addEventListener` in minified JS cannot be seen; a control with no label
  and no readable handler is protected only by the POST-form rule; `sendBeacon` callbacks are not
  treated as writes. `clickSkipRoutes` / `clickAllow` are the documented escapes.
- **Known over-redaction** (deliberate, best-effort): `token: value` in *prose* loses `value`
  (e.g. `"the token: <redacted> value"`), and a `--flag` followed by a quoted value in a JSON array
  is redacted. Narrower patterns were rejected because they leaked `"--password","SECRET_C"`.
- **Not verified in this round**: the real `modelRegistry.complete` vision call (W8's `judgeCalls`
  is proven with a stub registry that really is invoked once / zero times); the real
  `~/.pi/agent/vision-model.json` resolution path; `/reload` activation; the TUI rendering of the
  `info` action. `visualUpload.uploadOk` means "a judge call ran", not "the provider accepted the
  image" — a rejected upload still surfaces as `verdict unclear` ⇒ `SKIP`, never PASS.
- **Engine-level string parse, not a live runner**: R1's cases feed the exact strings the runners
  print (`pytest`, `jest`, `go`, `phpunit`, `rspec`, `tape`) through the real `runScripts`, but no
  pytest/jest/go/phpunit/rspec binary was executed on this machine for them.

## Fix round 3 — gate off by default (A) + seven residual defects (B1–B7)

A third independent/adversarial pass found one product requirement (the gate must be **off** by
default) and seven residual defects. Backup of the reviewed revision, taken before this round's
first edit, is outside the repo:

```console
$ ts=1790005484
$ cp -p mandatory-todo-delegation.ts /tmp/verify-fix3-baseline-$ts.ts        # md5 5deb9c720415cab791d5805c00806805
$ cp -p ui_probe.py                /tmp/verify-fix3-baseline-$ts.py          # md5 4ab5b07d71644a655ad826a39a8943c6
$ cp -p VERIFY.md                  /tmp/verify-fix3-baseline-$ts.VERIFY.md   # md5 d3176575acf23b692a754f58ca6d7dcc
$ cp -p SELFTEST.md                /tmp/verify-fix3-baseline-$ts.SELFTEST.md # md5 0ac87d1af8e4e9d75d64ee26ac18149a
$ md5sum mandatory-todo-delegation.ts ui_probe.py VERIFY.md      # tested + shipped revision
8f0824c58a09ad06db9c3a0ddc405f49  mandatory-todo-delegation.ts
dc92927c854b1806ea312c0bded562b3  ui_probe.py
b332f21ed716e4001a21757d0c012967  VERIFY.md
```

`ext/` in the harness holds byte-identical copies of the two tested sources (`md5sum
ext/mandatory-todo-delegation.ts ext/ui_probe.py` above); `ext-before/` holds the backup.

Harness: new dir `/tmp/fixproof3` (never touching `/tmp/rev`, `/tmp/rev3`, `/tmp/fixproof`,
`/tmp/fixproof2`). Real module + real `ui_probe.py` beside stub `typebox` and stub
`@earendil-works/pi-coding-agent`; both editions loaded in one process (after = `ext/`,
before = `ext-before/`); fixture HTTP server on 39751 (`apps/serve.mjs`, logs every request,
`POST` counted from the log); nothing listens on :3000 / :39752.

```console
$ cd /tmp/fixproof3 && node proof3.mjs > full.txt 2>&1 ; echo $?
0
```

Every line below is a copy of the `[id]` lines in `full.txt`.

### A — the automatic gate is OFF by default (proof 1 + 2)

```console
### A1 gate OFF (no config): nothing injected, nothing warns, everything still available
[A1] before_agent_start sections keys=[] returned=undefined
[A1] no-sections shape returned=undefined
[A1] agent_end notify=0 setStatus=0 (no report exists = worst case)
[A1] crew_close text="crew_close recorded (2/2 todos)."
[A1] crew_close details.verify={"status":"off","reason":"verify gate off (.pi/verify.json gate is not true)"}
[A1] crew_verify unit=PASS | 1/1 checks passed
[A1] crew_verify overall: PASS (enabled: unit; waived: none) report files=true
[A1] verify wave roles=[] mode=herdr head="verify (engine wave — no subagent lane; run the verifier and"

### A2 gate ON {"gate": true}: rule/status/warning return; noise guards
[A2] injected sections keys=["project_verify"]
[A2] fallback promptGuidelines=["Verify gate: call crew_verify (crew_dispatch "
[A2] report exists=true gate file kept=true
[A2] turn with NO source change: notify=0 status=["verify: PASS"]
[A2] changed sources: notify=1 (2 turns, same tree) status=["verify: stale"]
[A2] warning=["crew_verify: verification is stale — sources changed since 2026-09-21T15:55:32.195Z. Re-ru"]
[A2] crew_close text="crew_close recorded (1/1 todos).\nVerify: 1) no todo left in_progress 2) reviewer pass on the diff 3) briefings merged if they disagreed.\nWARN: verification is stale — ..."
[A2] crew_close setStatus=[["crew-verify","verify: stale"]]

### A3 invalid/unreadable config fails safe to OFF
[A3] gate:"yes": sections=[] agent_end notify=0
[A3] gate:true-as-string: sections=[] agent_end notify=0
[A3] malformed: sections=[] agent_end notify=0
[A3] gate:false: sections=[] agent_end notify=0
[A3] empty: sections=[] agent_end notify=0
```

A1 is the worst case for "sources changed": no report and no config at all, i.e. the tree moved and
`staleCheck` would have said `missing`. Nothing is injected, nothing is notified, no status is set —
and `crew_verify` still runs (PASS, report written), the `verify` wave still renders
(`roles=[] parallel=false`), and `/test-all` is untouched (it only calls `crew_verify`; its
`SKILL.md` §0 already documents the opt-in).
A2 shows the two noise guards: a fresh report on an unchanged tree sets the status but does **not**
notify, and a changed tree notifies exactly **once** across two `agent_end` calls.

### B1 — secret scrubbing (proof 3)

```console
[B1] sentinels in latest.json: []
[B1] sentinels in tool text : []
[B1] fields checked: target.url=http://127.0.0.1:39751/?key=<redacted> startCommand="node -e console.log(1) access_key=<redacted> private_key=<redacted>"
[B1]  configUsed.unit.args=[...,"--password","<redacted>"] configUsed.start.args=[...,"access_key=<redacted>","private_key=<redacted>"] configUsed.api.url="http://127.0.0.1:39751/api/items?key=<redacted>"
[B1]  unit item name="bash -c echo 'Authorization: <redacted> <redacted> echo 'token=<redacted>'; echo 'private_key=<redacted>'; echo '# pass 2' --password <redacted>"
[B1]  unit evidence.outputTail="Authorization: <redacted> <redacted>\ntoken=<redacted>\nprivate_key=<redacted>\n# pass 2"
[B1]  api items=[["PASS","GET http://127.0.0.1:39751/api/items?key=<redacted> -> 200"]]
[B1]  tool text has '<redacted>'=true and BEARER kept=false
```

Sentinels `SENT_BEARER, SENT_TOKEN, SENT_KEY, SENT_ACCESS, SENT_PRIV, SENT_ARR, SENT_URLKEY` were
grep-checked in **both** `.pi/verify/latest.json` and the returned tool text: zero hits in each.
Fields checked one by one: `target.url`, `target.startCommand`, `configUsed.start.args`,
`configUsed.unit.commands[].args`, `configUsed.api.endpoints[].url`, `unit.items[].name`,
`unit.items[].evidence.command`, `unit.items[].evidence.outputTail`, `api.items[].name`,
`nextActions[].evidence`, `nextActions[].action`, and the whole `matrixText` return.

Over-redaction counters, both editions, same corpus:

```console
[B1] over-redaction input="the token: prose value"      before="the token: <redacted> value"   after="the token: <redacted> value" (unchanged)
[B1] over-redaction input="--password quoted-value"     before="--password <redacted>"         after="--password <redacted>"       (unchanged)
[B1] over-redaction input="monkey=piano"                before="monkey=piano"                  after="monkey=piano"                (unchanged)
[B1] over-redaction input="hockey=stick"                before="hockey=stick"                  after="hockey=stick"                (unchanged)
[B1] over-redaction input="keyboard layout"             before="keyboard layout"               after="keyboard layout"             (unchanged)
[B1] over-redaction input="risk=high"                   before="risk=high"                     after="risk=high"                   (unchanged)
```

**Deviation from the written fix, stated plainly:** the fix note said to widen the alternation to
`[A-Za-z0-9_.-]*key\b`. Taken literally that regex also matches a word merely *ending* in "key":
measured on the before edition, `monkey=piano` → `monkey=<redacted>` and `hockey=stick` →
`hockey=<redacted>`, i.e. the >1px-overflow / 4-of-8-benign-controls noise-regression class the
hard rules forbid. The shipped branch is `\b(?:[A-Za-z0-9_.-]*[_-])?key\b`, which still matches
every required sentinel — `?key=`, `access_key=`, `private_key=`, bare `key=` — and leaves
`monkey=`/`hockey=` alone (counters above are all `unchanged`). VERIFY.md now documents this shape
instead of the old `*_key` overclaim.

### B2 — destructive sweep (proof 4)

```console
[B2] /onsubmit.html: status=PASS POST count=0
[B2]   clicks=[["Save note","skipped","destructive-looking (onsubmit writes (POST/PUT/PATCH/DELETE))"]]
[B2] /ancestor.html: status=PASS POST count=0
[B2]   clicks=[["Move card","skipped","destructive-looking (hx-post is a write)"]]
[B2] /beacon.html: status=PASS POST count=0
[B2]   clicks=[["Flush analytics","skipped","destructive-looking (onclick writes (POST/PUT/PATCH/DELETE))"]]
[B2] /preview.html: status=FAIL POST count=0
[B2]   clicks=[["Preview removal","dead-click","url unchanged, 0 mutations, no dialog, no popup"]]
[B2]   benign GET /api/soft-delete/preview reached the server: 1 time(s)
[B2] counter before (clickSkipRoutes): clicks=[] GETs=0
[B2] counter after : clicks=[{"target":"Preview removal","result":"dead-click",...}] GETs=1

### B2b regression: destructive.html still skips all 4, benign.html still clicks 4 of 8
[B2b] destructive.html POST count=0 skipped=3 clicks=[["Cancel order","skipped"],["Confirm changes","skipped"],["Apply now","skipped"],["Save note","changed"]]
[B2b] benign.html POST count=0 candidates=8 clicked=["Payments","Search Clear filters","Next page","Stop"] skipped=["Delete","Sign out","Confirm changes","Go"]
```

The three write fixtures are the reviewer's own: `<form onsubmit="event.preventDefault();fetch('/orders/42/cancel',{method:'POST'})"><button type=submit>Save note</button></form>`,
`<div hx-post="/orders/42/cancel"><button>Move card</button></div>`,
`<button onclick="navigator.sendBeacon('/orders/42/cancel')">`. All three: **POST count 0** and
recorded `skipped`. The reviewer's `POST /orders/42/cancel` + `POST /x` (count 2) and the unread
`hx-post`/`sendBeacon` are gone.
Benign counter: the reviewer's benign control `<button onclick="fetch('/api/soft-delete/preview')">Preview removal</button>`
is now **clicked** — the GET really reaches the server (`GETs=1`) where `clickSkipRoutes` gave
`GETs=0`. Its click result is `dead-click` (the handler fetches but mutates nothing) — that part is
the fixture's own shape, not a skip.
Regression counters unchanged from round 2: `destructive.html` → 3 skipped + `Save note` clicked,
**POST 0**; `benign.html` → 8 candidates, exactly 4 clicked / 4 skipped, **POST 0**.

### B3 — unit verdicts both ways (proof 5)

```console
[B3-1] want=FAIL got=FAIL | ... exit=0 but the output reports a failure (FAIL)
[B3-2] want=FAIL got=FAIL | ... exit=0 but the output reports a failure (FAILED)
[B3-3] want=FAIL got=FAIL | ... exit=0 but the runner reported failures — 3 passed, 1 failed
[B3-4] want=FAIL got=FAIL | ... exit=0 but the output reports a failure (not ok 1)
[B3-5] want=PASS got=PASS | ... exit=0 — 10 passed          (retrying after 2 failed attempts)
[B3-6] want=PASS got=PASS | ... exit=0 — 10 passed          (OK, but incomplete, skipped, or risky tests! Tests: 10, …)
[B3-7] want=PASS got=PASS | ... exit=0 — 2 passed           (go ok lines)
[B3-8] want=PASS got=PASS | ... exit=0 — 5 passed           (pytest)
[B3-9] want=PASS got=PASS | ... exit=0 — 10 passed          (rspec 10 examples, 0 failures)
[B3-10] want=PASS got=PASS | ... exit=0 — 10 passed         (jest Tests: 10 passed, 10 total)
[B3-11] want=PASS got=PASS | ... exit=0 — 10 passed         (phpunit OK (10 tests, 10 assertions))
[B3-12] want=PASS got=PASS | ... exit=0 — 4 passed          (BENIGN control: "0 errors")
```

Both directions: the three false passes (go `--- FAIL:` + `ok` lines at exit 0; pytest `FAILED` +
`N passed`; `3 passed, 1 error`) are `FAIL`, and the TAP `not ok 1` shape is too. The over-blocks
are gone: `retrying after 2 failed attempts` + `10 passed` is `PASS`, and PHPUnit's real
success-with-skips line (`OK, but incomplete, skipped, or risky tests! … Tests: 10, … Skipped: 2.`)
parses a positive count and is `PASS`. Healthy go / pytest / rspec / jest / phpunit outputs all
`PASS` **with a count**; the benign `0 errors` control is `PASS` (a zero count is not a failure).

### B4 — empty-document rule (proof 6)

```console
[B4] canvas-only /canvas.html: want=PASS status=PASS failSignals=[]
[B4]   crew_verify ui=PASS | 1/1 routes clean
[B4] image-only /imgonly.html: want=PASS status=PASS failSignals=[]
[B4]   crew_verify ui=PASS | 1/1 routes clean
[B4] empty root div /empty.html: want=FAIL status=FAIL failSignals=["empty document"]
[B4]   crew_verify ui=FAIL | 1/1 routes failed — /empty.html: empty document
[B4] whitespace-only /ws.html: want=FAIL status=FAIL failSignals=["empty document"]
[B4]   crew_verify ui=FAIL | 1/1 routes failed — /ws.html: empty document
[B4] text page /index.html: want=PASS status=PASS failSignals=[]
```

A text-free `<canvas>` chart page and an image-only poster page `PASS`; a truly empty
`<div id="root"></div>` and a whitespace-only body still `FAIL` `empty document`.

### B5 — waivers silence their dimension's actions (proof 7)

```console
[B5] waived run: overall=SKIP overall: SKIP (enabled: unit; waived: unit)
[B5]   dims=[["unit","SKIP","waived: legacy suite, tracked in TICKET-9"], ...]
[B5]   next=[["unit","info","unit dimension"]]
[B5]   blockers=0
[B5] control (not waived): overall=FAIL blockers=1
[B5] waiver + PASS: overall=PASS overall: PASS (enabled: unit, visual; waived: visual) blockers=0 info=1
```

A waived dimension with FAILing items emits **no `blocker`** — one `info` note records the waiver —
and the PASS/SKIP arithmetic is untouched (unit+visual, visual waived ⇒ `overall: PASS`; the same
failing unit without a waiver is still `overall: FAIL` with one `blocker`).

### B6 — serialization guard (proof 8)

```console
[B6] && joined: 1st blocked=false 2nd blocked=true reason="Blocked serial Herdr prompt — background each 'prompt --wait"
[B6] ; joined: 1st blocked=false 2nd blocked=true
[B6] newline joined: 1st blocked=false 2nd blocked=true
[B6] backgrounded & + wait: 1st blocked=false
[B6] lone prompt: 1st blocked=false 2nd (same family, serial) blocked=true
```

`&&` now behaves like the newline and `;` cases (`isSerialHerdrPrompt` looks for a *lone* `&`, not
any `&`), so a second serial call of the same family is blocked; the legitimate backgrounded form
(`… & p=$!` + `wait`) and a lone prompt are still not blocked.

### REGRESSION (proof 9)

```console
[REG-2] first scout blocked=false second scout blocked=true runs.all blocked=false builder blocked=false
[REG-3] 1st serial blocked=false 2nd serial blocked=true backgrounded blocked=false
[REG-4] verify wave roles=[] parallel=false mode=herdr
[REG-5] no-todos blocked=true reason=no-todos
[REG-5] incomplete blocked=true reason=incomplete-todos 1/3
[REG-6] serverStartedByVerify=true startCommand="bash -c sleep 300 & echo $! > gc.pid; wait"
[REG-6] grandchild pid=220005 alive after verify=false
[REG-6] overall: PASS (enabled: unit; waived: none)
[REG-1] node strip-types exit=0 stdout="import ok"
[REG-1] py_compile(after) exit=0 stderr=""
[REG-1] py_compile(before) exit=0 stderr=""
```

No orphan processes after the run and no listener left behind:

```console
$ ps -eo pid,ppid,etime,cmd | grep -Ei "serve\.mjs|ui_probe|proof3|sleep 300" | grep -v grep
(none)
$ ss -ltnp | grep -E "3975[12]|3000"
(no listener on 39751/39752/3000)
```

### B7 — docs corrected this round

- VERIFY.md: the `ui` row now discloses that a text-free page with `canvas`/`svg`/`img`/`video`/
  `iframe` is **not** "empty document" (the rule used to fail canvas-only/image-only pages);
- VERIFY.md: the destructive-detection section no longer claims a form-level `onsubmit` is covered
  by the element's own attributes — it now says the checks run over the element's and the ancestor
  chain's attributes, adds `sendBeacon(`, states that a verb in the *URL alone* is not destructive,
  and narrows the ceiling to "minified `addEventListener` only";
- VERIFY.md: the credential claim is corrected from `bearer`/`*_key` to the three shapes actually
  scrubbed (`key=value`, `Authorization: Bearer <token>`, `--flag value`) with an explicit
  **Not scrubbed** list (free-text `ui.expectedText` values, page text in `ariaSnapshot` unless a
  name precedes it, and anything only inside a screenshot PNG);
- VERIFY.md: new **Gate — off by default (opt-in)** section (what off means, the exact
  `{"gate": true}` opt-in, what stays available) plus `"gate": false` in the worked example;
- the `crew_verify` tool description now says the automatic gate is opt-in;
- SELFTEST.md: the round-2 note's own recorded `SELFTEST.md` md5 was already stale — corrected
  inline (see the "Correction (fix round 3)" line above).

### Round-3 honesty notes

- **One deviation from the written fix** (B1 regex, above): `\b(?:[A-Za-z0-9_.-]*[_-])?key\b`
  instead of the literal `[A-Za-z0-9_.-]*key\b`, because the literal also redacts
  `monkey=`/`hockey=`. Every required sentinel is covered and the over-redaction counters are
  unchanged; VERIFY.md documents the shipped shape.
- **Gate-off also removes the `crew_close` "Verify: 1) …" checklist**, not only the `WARN:` lines:
  the task called it "the crew_close verification reminder" and the tool description calls it "the
  verify checklist". If the intent was to keep that generic checklist while the gate is off, that
  one line needs to come back (it does not mention `crew_verify`).
- **`REMINDER` / `CREW_CHEATSHEET` still mention the verify gate.** They are one-shot
  `session_start` / `/crew` text, not the per-turn injected rule, and the task enumerated only the
  four automatic surfaces (rule, status, `agent_end`, `crew_close`) — so they were left alone.
  `crew_dispatch {wave:"verify"}` still prints "Soft gate: warnings only", which is only true with
  the gate on.
- **B2 ceiling unchanged except as documented**: a handler attached via `addEventListener` in
  minified JS is still invisible, and a benign-looking GET inside a `<form>` whose `action`
  contains a destructive verb is no longer skipped (the form's `action` string alone is treated as
  a URL, per the "only a write is destructive" rule). The `ui.clickSkipRoutes` / `ui.clickAllow`
  escapes are unchanged.
- **Still not verified by design** (unchanged from round 2): the real `modelRegistry.complete`
  vision call (the harness judge is a stub), the real `~/.pi/agent/vision-model.json` resolution,
  `/reload` activation, and the TUI rendering of the `info` action. `visualUpload.uploadOk` still
  means "a judge call ran", not "the provider accepted the image".
- Engine-level string parse, not live runners: B3 feeds the exact strings the runners print through
  the real `runScripts`; no go/pytest/phpunit/rspec/jest binary was executed for them.

## Correction and final round (R4-1, R4-2) — orchestrator-applied

Superseded round-3 notes above: (a) gate-OFF **no** longer removes the `crew_close` "Verify: 1) …"
checklist — it is unconditional again (that line is the crew close-out checklist, not a verify
reminder); (b) `REMINDER` and `CREW_CHEATSHEET` were **not** left alone — the session reminder drops
its trailing verify sentence when the gate is off (`REMINDER_ITEMS.slice(0, -1)`, an explicit slice;
the earlier regex over joined text could have swallowed any element appended later) and the
cheatsheet now states the gate is off by default; (c) the shipped `mandatory-todo-delegation.ts`
md5 recorded above is stale.

R4-1 — `Authorization: Basic <b64>` survived in cleartext in the report and the tool text.
`AUTH_CREDENTIAL` now redacts `Basic|Digest|NTLM|Bearer` after `authorization`/`proxy-authorization`,
and runs before `SECRETISH`. Raw (reviewer harnesses `basic.mjs` / `scrub2.mjs` against the patched
file):

```text
Authorization: <redacted> <redacted>          proxy-authorization: <redacted> <redacted>
dXNlcjpwYXNzd29yZA== in report: false | in tool text: false
YWRtaW46c2VjcmV0     in report: false | in tool text: false | cHJveHk6cHc= false
leakedInReport: []   leakedInText: []   nonSecretsRedactedInReport: []  (monkey/hockey/turkey intact)
```

Still NOT scrubbed (now listed in VERIFY.md): `publickey=`/`mykey=`/`regkey=`, PEM private-key
blocks, `postgres://user:pass@host`.

R4-2 — `formmethod="post"`, a `form="<id>"`-associated `submit()`, and `this.form.submit()`
fired real POSTs. Fixes: `formmethod` has its own write branch in the attribute scan, the `form=`
association is resolved when `closest('form')` is null, and `submit(` is a write handler. Raw
(fixture `server2.py` on :8901, its own request log; probe status FAIL only from pre-existing
console noise on unrelated routes):

```text
/s7-formaction-formmethod  skipped  "formmethod=post is a write"
/s12-submit-programmatic   skipped  "onclick writes (POST/PUT/PATCH/DELETE)"
/s12b-submit-closest       skipped  "onclick writes (POST/PUT/PATCH/DELETE)"
/s8-formaction-plain changed  /s18-benign-get-form changed
/s19-benign-fetch-get-opt changed  /s20-benign-preview-removal changed
POST lines in the server log: 0
```

Remaining ceiling, documented in VERIFY.md: an opaque handler calling a function defined elsewhere
(`onclick="submitOrder()"`, write inside a `<script>`) is not detected.

Shipped after this round: `mandatory-todo-delegation.ts` md5 `c9f690fce1656f554e63870a9683a06a`,
`ui_probe.py` md5 `0c4b21947bb8c15fd33cb84d4ca538cf` (the TS file immediately before this append;
`VERIFY.md`/`SELFTEST.md` carry no such claim).

## Removed: the Laya backend (decide-guard.ts), and the measurement that ended it

An optional on-box decision model (Laya, 421M params, Apache-2.0) was built into the `decide` tool and
`/guard route`: escalated keys were answered from a local python child instead of by the calling model.
It was fully tested — 243 assertions in the unit gate, A/B 8/8 arms, preflight PASS, an independent
review with 8 findings all fixed, and 41/41 correct answers on a mechanically-labelled corpus. **It was
removed anyway, on measurement, not on vibes.** The revision is in `laya-backup/` (this is not a git
repo and `ext-before/`, referenced elsewhere in this file, does not exist).

### The measurement: the control arm

Every earlier number compared the model to *rules*. None compared it to **the model that otherwise
answers those keys** — which is the whole question. Same 31 escalated real transcripts
(state = command + raw output, label = process exit status), one pi session, no extension:

| arm | accuracy | coverage | tokens | cost |
| --- | --- | --- | --- | --- |
| the caller (the model already in the loop) | **30/31 = 97%** | 31/31 = 100% | 3132 in / 4333 out | 0 — it is already there |
| Laya at gate 0.7 | 19/19 = **100%** | 19/31 = **61%** | **0** | 2.88 GB RAM, 22.6 s cold, torch pin |

The backend is not more accurate than the caller; it is more accurate **only on the 61% it chooses to
answer**, and the other 39% goes straight back to the same model — which is also why both failed on the
same input class (states with nothing to read: `bash -c exit 3` was the caller's one miss; `false`,
`test -f` and `rm -rf` on a missing path were Laya's sub-gate misses). Net: **≈84 output tokens saved per
escalated judgement** for 2.88 GB resident and a 22.6 s cold start.

### Usage: the path was never taken

`decide` was called **24 times across 687 recorded session files** (21 sessions, mostly 1–2 calls), against
`bash` 11672, `read` 4169, `edit` 1975, `todo` 1815. The backend was off by default, so it answered ~none
of them. It optimised a path taken in ~3% of sessions, ~0.03% of tool calls.

### Gate calibration (kept: it is the only out-of-sample measurement of the model in this repo)

38 real commands executed, states built from command + raw output, labels from exit status. Rules
answered 7 (all correct); the 31 that escalated went to both checkpoints through the real bridge:

| gate | typed-decisions (default) | | english root | |
| --- | --- | --- | --- | --- |
| | resolved | accuracy | resolved | accuracy |
| 0.50 | 31 (100%) | 94% | 31 (100%) | 94% |
| 0.60 | 25 (81%) | 100% | 24 (77%) | 96% |
| 0.70 | 19 (61%) | 100% | 22 (71%) | 100% |
| 0.90 | 0 (0%) | — | 12 (39%) | 100% |

### Why the other options lost

- **Harden it:** the gate abstains on 30–39% of the population already; only ~6 accuracy points were left
  to buy, on a path used 24 times ever, at 2.88 GB and a Python-3.14/torch-2.14 pin that upstream CI does
  not test (3.14 is in no CI matrix) — while `node decide-guard.ts` stays green with no python, so CI
  would never have caught it rotting.
- **Narrow it to `/guard route` or compaction judging:** `/guard route` is a 7-way `pick` — the model's
  weakest primitive (measured argmax 0.29–0.80, sub-0.10 margins) — and has no recorded invocation.
  Compaction keep/drop runs often, has no ground truth, is KEEP-biased by default, and a wrong drop loses
  real evidence: the worst place for a 94%-argmax model.
- **Leave it merged but off:** zero runtime cost, but 567 dead-but-audited lines in the one file whose
  identity is "no dependencies", plus the standing obligation to keep its claims, counts and md5s true.

### The revert, and how it was verified

`decide-guard.ts` went back to the rules-only version. Proof, because "I deleted some lines" is not proof:

```console
$ node decide-guard.ts
223 passed, 0 failed — 121 bash rows (71 must-block, 50 must-allow), 5 path rows, 97 engine assertions
$ wc -l decide-guard.ts
1117 decide-guard.ts
$ grep -c 'laya\|spawn\|child_process\|resolveEscalated\|backendKill' decide-guard.ts
0
$ grep -n 'await ' decide-guard.ts
791:  const ok = await ctx.ui?.confirm?.(...)        # the only two, both pre-existing
865:  const { Type } = (await import("typebox")) ...
```

1117 lines, 121/71/50/5/97 — the same file the pre-Laya revision printed. `decide-guard.ab.mjs` and
`decide-guard.ab-preflight.sh` were reverted too (their `DECIDE_GUARD_LAYA*` scrub and the latency-line
note are gone). One deliberately kept fix: the preflight's unset loop now uses `^PI_[A-Z0-9_]*` instead of
`^PI_[A-Z_]*`, so digit-bearing names like `PI_2FA` are scrubbed from child arms — a latent bug on that
loop, unrelated to Laya, and the only diff from the pre-Laya text.

Removed with it: `.laya/venv` (1.2 GB) and `~/.cache/huggingface` (1.6 GB) — 2.8 GB total. Kept:
`.laya/bridge.py`, `.laya/README.md` (rebuild recipe) and `upstream-reports/laya-brief.md` (32 KB of
sourced upstream research), so the option costs ~5 minutes to restore if a batch workload ever wants a
0-token typed-decision service.

The tool description is byte-for-byte the original again — "local rules alone — no model, no tokens, no
network" — and that claim is now true in the strong sense: there is no process, no weights, no python
and no network anywhere behind `decide`.

## The crew split — dispatcher + `crew-verify.ts`, 2026-09-22

`mandatory-todo-delegation.ts` was split in two on 2026-09-22. The dispatcher kept `crew_open`,
`crew_dispatch`, `crew_close`, the session reminder and `/crew`; the `crew_verify` tool, the
`before_agent_start` rule, the `agent_end` staleness notice and the whole verify engine moved into a
new sibling `crew-verify.ts`, imported by the dispatcher as `./crew-verify.ts` (so both files must be
symlinked into `~/.pi/agent/extensions/` — linking only the dispatcher loads neither the crew tools
nor `crew_verify`, since `./crew-verify.ts` cannot resolve there). The split report recorded 2982
lines before, 582 for the dispatcher and 2269 for the new file; the pre-split copy no longer exists,
so that figure is not re-measurable. What is measurable, after this round's two nit fixes:

```console
$ wc -l mandatory-todo-delegation.ts crew-verify.ts
  608 mandatory-todo-delegation.ts
 2272 crew-verify.ts
```

Three things this round observed that the code does not say out loud:

- **`.pi/verify/latest.json` in this repo is from the refactor verification, not from an original
  pre-split run.** A real `crew_verify` run during the refactor's verification overwrote it, so its
  timestamp is later than the evidence it replaced.
- **A generated workflow `.mjs` is executed as an async-IIFE statement body, not as a module.** A plain
  `import()` parse check on it always fails with `Illegal return statement`, even when the artifact is
  perfect — a top-level `return` is legal in a function body and illegal in a module. The correct checks
  are pi-subagents' `validateWorkflowScript` export plus executing the text as an async function body.
- **`runs.all` resolves to an ORDERED array, not a key map.** Keyed property access throws
  (`src/workflows/scripted-workflow.js:296`, "runs.all resolves to an ordered array"), so every consumer
  stays positional: `results[0]`, `results.map((r) => r.output)`, never `results["scout-a"]`.

```console
$ node --input-type=module -e 'import("./artifacts/light.mjs").catch(e => console.log(e.name + ": " + e.message))'
SyntaxError: Illegal return statement
$ node --input-type=module -e 'new (Object.getPrototypeOf(async function(){}).constructor)("runs", readFileSync("artifacts/light.mjs", "utf8"))'
AsyncFunction body parse: OK
```
