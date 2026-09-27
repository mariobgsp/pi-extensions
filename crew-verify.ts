/**
 * crew-verify — the project verification gate (crew_verify).
 *
 * The policy (when to verify, what PASS/FAIL/SKIP mean, the 3-cycle cap) lives in
 * ~/.pi/agent/AGENT.md §5, not here. This file is the executor: it runs the checks,
 * refuses to call an unevidenced dimension a pass, and writes .pi/verify/latest.json.
 * One sibling file: ui_probe.py, resolved from import.meta.url (never cwd).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import {
 existsSync,
 mkdirSync,
 readFileSync,
 readdirSync,
 realpathSync,
 renameSync,
 statSync,
 writeFileSync,
} from "node:fs";
import {
 dirname,
 extname,
 isAbsolute,
 join,
 relative,
 resolve,
 sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// verify engine (crew_verify) — helpers. No side effects at import time.
// One sibling file: ui_probe.py, resolved from import.meta.url (never cwd).
// ---------------------------------------------------------------------------

const PI_DIR = ".pi";
const VERIFY_MAX_ITERATIONS = 3;
const VERIFY_DIMS = ["unit", "api", "ui", "visual"] as const;
type VerifyDim = (typeof VERIFY_DIMS)[number];
type VerifyStatus = "PASS" | "FAIL" | "SKIP" | "WARN";
type VerifyEvidence = {
 command: string;
 exitCode: number | null;
 outputTail: string;
 artifacts: string[];
};
type VerifyItem = {
 name: string;
 status: VerifyStatus;
 reason: string;
 evidence: VerifyEvidence;
};
type DimensionResult = {
 name: VerifyDim;
 enabled: boolean;
 status: VerifyStatus;
 reason: string | null;
 durationMs: number;
 items: VerifyItem[];
};

const DEFAULT_VERIFY_CONFIG: any = {
 dimensions: [...VERIFY_DIMS],
 timeoutMs: 120000,
 start: null,
 unit: { commands: [] },
 api: { commands: [], endpoints: [] },
 ui: { url: null, routes: [], clickBudget: 8 },
 visual: { routes: [] },
 waivers: [],
};

// Every child is its own process group; the group is the only reliable kill unit.
const LIVE_GROUPS = new Set<number>();

function killGroup(pid?: number): void {
 if (!pid) return;
 LIVE_GROUPS.delete(pid);
 try {
  process.kill(-pid, "SIGKILL");
 } catch {
  // already gone
 }
}

function killAllGroups(): void {
 for (const pid of [...LIVE_GROUPS]) killGroup(pid);
}

function cap(s: string, n: number): string {
 const t = s === null || s === undefined ? "" : String(s);
 return t.length <= n ? t : `${t.slice(0, n)}…[+${t.length - n} chars]`;
}

function tailOf(s: string, n: number): string {
 const t = s === null || s === undefined ? "" : String(s);
 return t.length <= n ? t : `…[+${t.length - n} chars]${t.slice(-n)}`;
}

function sha256(s: string): string {
 return createHash("sha256").update(s).digest("hex");
}

type RunResult = {
 exitCode: number | null;
 stdout: string;
 stderr: string;
 outputTail: string;
 durationMs: number;
 timedOut: boolean;
};

const MAX_CAPTURE = 65536; // last 64 KB only — never dump a whole test log into the report

function spawnCollect(
 cmd: string,
 args: string[],
 opts: { cwd?: string; timeoutMs: number; env?: any },
): Promise<RunResult> {
 return new Promise((done) => {
  const started = Date.now();
  const finish = (r: Partial<RunResult>) =>
   done({
    exitCode: null,
    stdout: out,
    stderr: err,
    outputTail: tailOf(`${out}\n${err}`.trim(), 4000),
    durationMs: Date.now() - started,
    timedOut: false,
    ...r,
   });
  let out = "";
  let err = "";
  let child: any;
  try {
   child = spawn(cmd, args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env ?? process.env,
   });
  } catch (e) {
   return finish({ outputTail: `spawn failed: ${String(e)}` });
  }
  const pid: number | undefined = child.pid;
  if (pid) LIVE_GROUPS.add(pid);
  const push = (which: "out" | "err", chunk: any) => {
   const s = String(chunk);
   if (which === "out") out = (out + s).slice(-MAX_CAPTURE);
   else err = (err + s).slice(-MAX_CAPTURE);
  };
  try {
   child.stdout?.on("data", (b: any) => push("out", b));
   child.stderr?.on("data", (b: any) => push("err", b));
  } catch {
   // stdio unavailable
  }
  const timer = setTimeout(() => {
   killGroup(pid);
   finish({ timedOut: true, exitCode: null });
  }, Math.max(opts.timeoutMs, 1));
  child.once("error", (e: any) => {
   clearTimeout(timer);
   if (pid) LIVE_GROUPS.delete(pid);
   finish({ outputTail: `spawn error: ${String(e?.message ?? e)}` });
  });
  child.once("close", (code: number | null) => {
   clearTimeout(timer);
   if (pid) LIVE_GROUPS.delete(pid);
   finish({ exitCode: code });
  });
 });
}

function runCommand(
 cmd: string,
 args: string[],
 cwd: string,
 timeoutMs: number,
 env?: any,
): Promise<RunResult> {
 return spawnCollect(cmd, args, { cwd, timeoutMs, env });
}

// Paths are a trust boundary: everything resolved against root must stay inside it.
function confine(root: string, p: string): string | null {
 const r = resolve(root);
 const abs = isAbsolute(p) ? resolve(p) : resolve(r, p);
 if (abs === r || abs.startsWith(r + sep)) return abs;
 return null;
}

const FP_SKIP_DIRS = new Set([
 "node_modules",
 ".git",
 "dist",
 "build",
 "out",
 ".next",
 ".venv",
 "venv",
 "__pycache__",
 "coverage",
 "target",
 ".cache",
]);

function fingerprint(root: string): {
 hash: string;
 revision: { path: string; mtimeMs: number; size: number }[];
 truncated: boolean;
} {
 const files: { path: string; mtimeMs: number; size: number }[] = [];
 let truncated = false;
 const MAX_FILES = 4000;
 const MAX_REVISION = 200;
 const MAX_DEPTH = 12;
 const verifyRel = join(PI_DIR, "verify");
 // .pi/crew/*.{mjs,sh,json} is rewritten by every crew_dispatch, so it is not a source either.
 const crewRel = join(PI_DIR, "crew");
 const walk = (dir: string, depth: number): void => {
  if (files.length >= MAX_FILES || depth > MAX_DEPTH) {
   truncated = true;
   return;
  }
  let entries: any[];
  try {
   entries = readdirSync(dir, { withFileTypes: true });
  } catch {
   return;
  }
  for (const e of entries) {
   if (files.length >= MAX_FILES) {
    truncated = true;
    return;
   }
   const name = String(e.name);
   if (FP_SKIP_DIRS.has(name)) continue;
   const abs = join(dir, name);
   const rel = relative(root, abs);
   if (rel === verifyRel || rel.startsWith(verifyRel + sep) || rel === crewRel || rel.startsWith(crewRel + sep)) continue;
   let st: any;
   try {
    st = statSync(abs);
   } catch {
    continue;
   }
   if (st.isDirectory()) walk(abs, depth + 1);
   else if (st.isFile())
    files.push({ path: rel, mtimeMs: st.mtimeMs, size: st.size });
  }
 };
 walk(resolve(root), 0);
 files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
 const hash = `sha256:${sha256(
  files.map((f) => `${f.path}\0${f.size}\0${Math.round(f.mtimeMs)}`).join("\n"),
 )}`;
 return {
  hash,
  revision: files.slice(0, MAX_REVISION),
  truncated: truncated || files.length > MAX_REVISION,
 };
}

function loadConfig(
 root: string,
 configPath: string,
): { path: string | null; cfg: any; reason: string | null } {
 const abs = confine(root, configPath);
 if (!abs)
  return {
   path: null,
   cfg: DEFAULT_VERIFY_CONFIG,
   reason: `config path escapes project root: ${configPath}`,
  };
 if (!existsSync(abs))
  return { path: null, cfg: DEFAULT_VERIFY_CONFIG, reason: null };
 try {
  const parsed = JSON.parse(readFileSync(abs, "utf8")) ?? {};
  const cfg: any = {
   ...DEFAULT_VERIFY_CONFIG,
   ...parsed,
   unit: { ...DEFAULT_VERIFY_CONFIG.unit, ...(parsed.unit ?? {}) },
   api: { ...DEFAULT_VERIFY_CONFIG.api, ...(parsed.api ?? {}) },
   ui: { ...DEFAULT_VERIFY_CONFIG.ui, ...(parsed.ui ?? {}) },
   visual: { ...DEFAULT_VERIFY_CONFIG.visual, ...(parsed.visual ?? {}) },
  };
  if (!Array.isArray(cfg.dimensions)) cfg.dimensions = [...VERIFY_DIMS];
  if (!Array.isArray(cfg.waivers)) cfg.waivers = [];
  return { path: abs, cfg, reason: null };
 } catch (e) {
  return {
   path: abs,
   cfg: DEFAULT_VERIFY_CONFIG,
   reason: `malformed ${configPath}: ${String((e as any)?.message ?? e)}`,
  };
 }
}

// Secrets never enter the report. redactConfig masks start.env plus obvious credentials
// (unit.commands[].args, api.endpoints[].url); scrubSecrets is applied to the whole report +
// tool text at the end (see scrubDeep/writeReport). Three shapes are covered: `key=value` /
// `key: value` (credential-shaped names incl. `_key`/`-key`/bare `key`, `*_token`, `*secret`,
// `api_key`, `authorization` — the `key` branch is word-boundary guarded, so `access_key=` /
// `private_key=` / `?key=` match while a word merely *ending* in "key" (`monkey=`) does not), `Authorization: Bearer <tok>` (the token sits *after* the scheme word, so
// the name=value shape alone would only eat the literal "Bearer"), and `--flag value` —
// including the JSON-array form of an argv (`"--password","SECRET_C"`). NOT covered, stated
// plainly: a bare secret with no credential-shaped name next to it (free-text `ui.expectedText`
// values and page text captured in `ariaSnapshot` are only caught when a name precedes them), and
// innocent text after a credential-shaped name (`token:`) or a `key`-named field is over-redacted.
const SECRETISH =
 /((?:[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|bearer|authorization)[A-Za-z0-9_.-]*|\b(?:[A-Za-z0-9_.-]*[_-])?key\b)\s*["']?\s*[=:]\s*["']?)([^\s"'\\]{4,})/gi;
const BEARER_TOKEN = /(\bbearer\s+)(\S{4,})/gi;
// `Authorization: Basic <b64>` / Digest / NTLM / Bearer: the credential sits *after* the scheme
// word, so the name=value shape alone would only eat the scheme and leave the secret in the report.
// Runs BEFORE SECRETISH (which would otherwise consume just the literal "Bearer").
const AUTH_CREDENTIAL =
 /(\b(?:proxy-)?authorization\s*["']?\s*[:=]\s*["']?\s*(?:basic|digest|ntlm|bearer)?\s*)([^\s"']{4,})/gi;
const SECRETISH_FLAG =
 /(--[A-Za-z0-9-]*(?:token|secret|password|passwd|key)[A-Za-z0-9-]*["']?\s*[:=,]?\s*["']?)([^\s"'\\,]{4,})/gi;
function scrubSecrets(s: string): string {
 return String(s)
  .replace(AUTH_CREDENTIAL, "$1<redacted>")
  .replace(BEARER_TOKEN, "$1<redacted>")
  .replace(SECRETISH, "$1<redacted>")
  .replace(SECRETISH_FLAG, "$1<redacted>");
}

// The report is scrubbed as a whole, at the last boundary before it is written and before
// the tool text/details are built from it (target.url, target.startCommand, nextActions and
// every evidence string all travel through here).
function scrubDeep(v: any): any {
 if (typeof v === "string") return scrubSecrets(v);
 if (Array.isArray(v)) return v.map(scrubDeep);
 if (v && typeof v === "object") {
  const out: any = {};
  for (const [k, val] of Object.entries(v)) out[k] = scrubDeep(val);
  return out;
 }
 return v;
}

function redactConfig(cfg: any): any {
 try {
  const c = JSON.parse(JSON.stringify(cfg));
  if (c.start && typeof c.start === "object")
   c.start = { ...c.start, env: "<redacted>" };
  return JSON.parse(scrubSecrets(JSON.stringify(c)));
 } catch {
  return { error: "config not serializable" };
 }
}

function readPackageJson(root: string): { scripts: any; workspaces: any } | null {
 const p = join(root, "package.json");
 if (!existsSync(p)) return null;
 try {
  const j = JSON.parse(readFileSync(p, "utf8"));
  return { scripts: j?.scripts ?? {}, workspaces: j?.workspaces };
 } catch {
  return null;
 }
}

type Detected = { commands: { command: string; args: string[] }[]; searched: string[] };

function detectUnitCommands(root: string): Detected {
 const searched = [
  "package.json scripts.test:unit",
  "package.json scripts.test",
  "pytest (pytest.ini | pyproject.toml | tests/)",
  "go test ./...",
 ];
 const commands: { command: string; args: string[] }[] = [];
 const pkg = readPackageJson(root);
 if (pkg) {
  if (pkg.scripts?.["test:unit"])
   commands.push({ command: "npm", args: ["run", "test:unit"] });
  if (pkg.scripts?.test) commands.push({ command: "npm", args: ["test"] });
  if (pkg.workspaces && commands.length)
   commands.push({ command: "npm", args: ["test", "--workspaces", "--if-present"] });
 }
 if (
  existsSync(join(root, "pytest.ini")) ||
  existsSync(join(root, "pyproject.toml")) ||
  existsSync(join(root, "tests"))
 )
  commands.push({ command: "python3", args: ["-m", "pytest", "-q"] });
 if (existsSync(join(root, "go.mod")))
  commands.push({ command: "go", args: ["test", "./..."] });
 return { commands, searched };
}

function detectApiCommands(root: string): Detected {
 const searched = [
  "package.json scripts.test:api",
  "package.json scripts.test:integration",
  "pytest (tests/api | tests/integration)",
 ];
 const commands: { command: string; args: string[] }[] = [];
 const pkg = readPackageJson(root);
 const s = pkg?.scripts ?? {};
 if (s["test:api"]) commands.push({ command: "npm", args: ["run", "test:api"] });
 else if (s["test:integration"])
  commands.push({ command: "npm", args: ["run", "test:integration"] });
 if (!pkg) {
  if (existsSync(join(root, "tests", "api")) || existsSync(join(root, "tests", "integration")))
   commands.push({ command: "python3", args: ["-m", "pytest", "-q", "tests/api", "tests/integration"] });
 }
 return { commands, searched };
}

function testSummary(out: string): string {
 const pass = testCount(out);
 const fail = failedCount(out);
 const bits: string[] = [];
 if (pass !== null) bits.push(`${pass} passed`);
 if (fail !== null && fail !== 0) bits.push(`${fail} failed`);
 return bits.join(", ");
}

// Failures are read from the runner's own output, never from the exit code alone: a piped or
// "|| true" runner (`vitest run | tee log`, `jest || true`) exits 0 while its output reports
// failed tests. A failure count > 0 is a FAIL whatever the exit code says.
// A count-shaped phrase that is really a retry note ("retrying after 2 failed attempts") is not
// a failure: the words right after the number decide, so a healthy suite stays a PASS.
const RETRY_AFTER = /^[\s,:.]*(?:attempts?|times?|retr(?:y|ying|ies|ied)|resolved|recovered|flak)/i;
function failedCount(out: string): number | null {
 const patterns = [
  /#\s*fail\s+(\d+)/gi,
  /(\d+)\s+(?:tests?\s+|specs?\s+)?(?:failed|failing|failures?)\b/gi,
  /(\d+)\s+errors?\b/gi,
 ];
 for (const re of patterns) {
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
   const tail = out.slice(m.index + m[0].length, m.index + m[0].length + 24);
   if (RETRY_AFTER.test(tail)) continue;
   return Number(m[1]);
  }
 }
 return null;
}

// Text-shaped failure signals with no count: go's per-package `FAIL`, `--- FAIL:`, TAP's
// `not ok N` and pytest's `FAILED`. Case-sensitive on purpose (a lowercase "failed" in prose
// is what the retry exclusion above already handles).
function reportedFailureText(out: string): string | null {
 const m =
  out.match(/^[ \t]*FAIL\b/m) ??
  out.match(/^[ \t]*---\s*FAIL:/m) ??
  out.match(/^[ \t]*not ok\s+\d+/m) ??
  out.match(/\bFAILED\b/);
 return m ? m[0].trim() : null;
}

// A test count is the only proof a runner actually ran something. Anchored: "10 passed"
// must not read as "0 passed" (the old unanchored pattern was a false negative).
function zeroTests(out: string): boolean {
 return (
  /no tests?\s+(ran|found)/i.test(out) ||
  /\b0\s+(tests?\s+)?passed\b/i.test(out) ||
  /\b0 passing\b/i.test(out) ||
  /no test files/i.test(out)
 );
}

function testCount(out: string): number | null {
 const m =
  out.match(/#\s*pass\s+(\d+)/i) ??
  out.match(/(\d+)\s+(?:tests?\s+|specs?\s+)?passed\b/i) ??
  out.match(/(\d+)\s+(?:tests?\s+)?ok\b/i) ??
  out.match(/(\d+)\s+passing\b/i) ??
  // phpunit: "OK (10 tests, 10 assertions)" / "OK, but incomplete, skipped, or risky tests! … Tests: 10, …"
  out.match(/\bOK\s*\(\s*(\d+)\s+tests?/i) ??
  out.match(/\bTests:\s*(\d+)/i) ??
  // rspec: "10 examples, 0 failures"
  out.match(/\b(\d+)\s+examples?\s*,/i);
 if (m) return Number(m[1]);
 // go test (non-verbose) prints one "ok <pkg> <time>" line per passing package and no test
 // count at all: the ok lines are the only count there is.
 const ok = out.match(/(?:^|\n)\s*ok\s+\S+/g);
 return ok ? ok.length : null;
}

function dim(
 name: VerifyDim,
 status: VerifyStatus,
 reason: string | null,
 startedAt: number,
 items: VerifyItem[],
 enabled = true,
): DimensionResult {
 return {
  name,
  enabled,
  status,
  reason,
  durationMs: Date.now() - startedAt,
  items: items.slice(0, 50),
 };
}

async function runScripts(
 commands: { command: string; args: string[] }[],
 root: string,
 dimName: VerifyDim,
 remainingFn: () => number,
): Promise<VerifyItem[]> {
 const items: VerifyItem[] = [];
 for (const c of commands) {
  const cmd = String(c?.command ?? "");
  const args = Array.isArray(c?.args) ? c.args.map(String) : [];
  const name = scrubSecrets(`${cmd} ${args.join(" ")}`.trim());
  if (!cmd) {
   items.push({
    name: "(empty command)",
    status: "SKIP",
    reason: "config command has no argv[0]",
    evidence: { command: "", exitCode: null, outputTail: "", artifacts: [] },
   });
   continue;
  }
  const remaining = remainingFn();
  if (remaining < 1500) {
   items.push({
    name,
    status: "SKIP",
    reason: "budget exhausted",
    evidence: { command: name, exitCode: null, outputTail: "", artifacts: [] },
   });
   continue;
  }
  const r = await runCommand(cmd, args, root, remaining);
  const evidence: VerifyEvidence = {
   command: scrubSecrets(name),
   exitCode: r.exitCode,
   outputTail: cap(scrubSecrets(r.outputTail), 2000),
   artifacts: [],
  };
  const combined = `${r.stdout}\n${r.stderr}`;
  if (r.timedOut) {
   items.push({
    name,
    status: "FAIL",
    reason: `${dimName} command timed out after ${r.durationMs}ms`,
    evidence,
   });
   continue;
  }
  const reportedFails = failedCount(combined);
  const failText = reportedFailureText(combined);
  if (r.exitCode === 0) {
   const n = testCount(combined);
   if (reportedFails && reportedFails > 0) {
    // The runner's own failure count beats the exit code: "3 passed, 1 failed" with exit 0
    // (piped reporter) is a FAIL, and a PASS reason containing "failed" would be a lie.
    const sum = testSummary(combined);
    items.push({
     name,
     status: "FAIL",
     reason: `${name} exit=0 but the runner reported failures${sum ? ` — ${sum}` : ""}`,
     evidence,
    });
   } else if (failText) {
    // go/pytest/TAP print a failure marker with no count at all; `ok <pkg>` lines for other
    // packages must not turn that into a count-shaped PASS (B3).
    items.push({
     name,
     status: "FAIL",
     reason: `${name} exit=0 but the output reports a failure (${cap(failText, 60)})`,
     evidence,
    });
   } else if (zeroTests(combined) || !n)
    items.push({
     name,
     status: "SKIP",
     reason: zeroTests(combined)
      ? "runner ran no tests (exit=0, no test count)"
      : "exit 0 but no test count reported",
     evidence,
    });
   else {
    const sum = testSummary(combined);
    items.push({
     name,
     status: "PASS",
     reason: `${name} exit=0${sum ? ` — ${sum}` : ` — ${n} tests`}`,
     evidence,
    });
   }
  } else {
   const sum = testSummary(combined);
   items.push({
    name,
    status: "FAIL",
    reason: `${name} exit=${r.exitCode}${sum ? ` — ${sum}` : ""}`,
    evidence,
   });
  }
 }
 return items.slice(0, 50);
}

function roll(items: VerifyItem[], emptyReason: string): {
 status: VerifyStatus;
 reason: string | null;
} {
 if (!items.length) return { status: "SKIP", reason: emptyReason };
 const fails = items.filter((i) => i.status === "FAIL").length;
 const passes = items.filter((i) => i.status === "PASS").length;
 // A SKIP (never spawned / budget starved) or a WARN is not a pass: the dimension can only
 // PASS when every check actually ran and passed.
 const open = items.filter((i) => i.status === "SKIP" || i.status === "WARN");
 const named = open
  .slice(0, 3)
  .map((i) => `${i.name} (${cap(String(i.reason ?? ""), 80)})`)
  .join("; ");
 if (fails)
  return {
   status: "FAIL",
   reason: `${fails}/${items.length} checks failed${open.length ? `, ${open.length} did not run or warned` : ""}`,
  };
 if (open.length)
  return {
   status: "SKIP",
   reason: `${open.length}/${items.length} checks did not run or warned: ${named}`,
  };
 if (passes) return { status: "PASS", reason: `${passes}/${items.length} checks passed` };
 return {
  status: "SKIP",
  reason: items[0]?.reason ?? "no executed evidence",
 };
}

async function probeUrlOnce(
 url: string,
 timeoutMs = 2000,
): Promise<{ ok: boolean; reason: string | null }> {
 try {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  try {
   await r.arrayBuffer();
  } catch {
   // body already gone
  }
  return {
   ok: r.status < 500,
   reason: r.status < 500 ? null : `status ${r.status}`,
  };
 } catch (e) {
  return { ok: false, reason: String((e as any)?.message ?? e) };
 }
}

async function waitForUrl(
 url: string,
 budgetMs: number,
): Promise<{ ok: boolean; reason: string | null }> {
 const deadline = Date.now() + Math.max(budgetMs, 0);
 let last = "no response";
 while (Date.now() < deadline) {
  const r = await probeUrlOnce(url, 2000);
  if (r.ok) return r;
  last = r.reason ?? last;
  await new Promise((res) => setTimeout(res, 250));
 }
 return { ok: false, reason: `not ready within ${budgetMs}ms (${last})` };
}

async function startDevServer(
 cfg: any,
 root: string,
 budgetMs: number,
): Promise<{ started: boolean; ok: boolean; reason: string | null; pid?: number }> {
 const s = cfg?.start;
 if (!s || typeof s.command !== "string")
  return { started: false, ok: false, reason: "no start command configured" };
 const url = typeof s.url === "string" ? s.url : (cfg?.ui?.url ?? null);
 if (!url)
  return { started: false, ok: false, reason: "start declared without a url to poll" };
 const args = Array.isArray(s.args) ? s.args.map(String) : [];
 let child: any;
 try {
  child = spawn(s.command, args, {
   cwd: root,
   detached: true,
   stdio: ["ignore", "ignore", "ignore"],
   env: { ...process.env, ...(s.env ?? {}) },
  });
 } catch (e) {
  return { started: false, ok: false, reason: `start failed: ${String(e)}` };
 }
 const pid: number | undefined = child.pid;
 if (pid) LIVE_GROUPS.add(pid);
 let spawnErr: string | null = null;
 child.once("error", (e: any) => {
  spawnErr = String(e?.message ?? e);
 });
 const readyBudget = Math.min(Number(s.readyTimeoutMs ?? 30000) || 30000, Math.max(budgetMs, 1500));
 const ready = await waitForUrl(url, readyBudget);
 if (spawnErr)
  return {
   started: true,
   ok: false,
   reason: `start command failed to spawn: ${spawnErr}`,
   pid,
  };
 if (!ready.ok) {
  killGroup(pid);
  return {
   started: true,
   ok: false,
   reason: `start command ran but ${url} never became reachable (${ready.reason})`,
   pid,
  };
 }
 return { started: true, ok: true, reason: null, pid };
}

// The probe is a sibling of this file. Loader-dependent path reporting (pi loads
// extensions through jiti; a symlinked extension may report either the symlink or its
// real target), so try every plausible sibling instead of trusting one.
function probeScriptPath(): string | null {
 const here = fileURLToPath(import.meta.url);
 const candidates = [dirname(here)];
 try {
  candidates.push(dirname(realpathSync(here)));
 } catch {
  // not a real path
 }
 candidates.push(join(homedir(), ".pi", "agent", "extensions"));
 for (const dir of new Set(candidates)) {
  const p = join(dir, "ui_probe.py");
  if (existsSync(p)) return p;
 }
 return null;
}

async function runProbe(
 specPath: string,
 timeoutMs: number,
): Promise<{
 json: any | null;
 reason: string | null;
 stdout: string;
 exitCode: number | null;
 durationMs: number;
}> {
 const script = probeScriptPath();
 if (!script)
  return {
   json: null,
   reason: `ui_probe.py not found beside the extension (${dirname(fileURLToPath(import.meta.url))})`,
   stdout: "",
   exitCode: null,
   durationMs: 0,
  };
 let r = await spawnCollect("python3.14", [script, "--spec", specPath], {
  timeoutMs,
 });
 if (r.exitCode === null && !r.timedOut)
  r = await spawnCollect("python3", [script, "--spec", specPath], { timeoutMs });
 const raw = r.stdout.trim();
 if (r.timedOut)
  return {
   json: null,
   reason: `probe timed out after ${r.durationMs}ms`,
   stdout: cap(raw, 2000),
   exitCode: r.exitCode,
   durationMs: r.durationMs,
  };
 const brace = raw.indexOf("{");
 if (brace < 0) {
  // Distinguish "python/playwright missing" from "the probe ran and printed junk".
  const spawnFail = /spawn error|spawn failed/i.test(`${raw}${r.stdout}${r.stderr}${r.outputTail}`);
  return {
   json: null,
   reason: spawnFail
    ? `cannot run the ui probe (missing python3.14/python3?): ${cap(r.outputTail, 200)}`
    : `probe produced no JSON: ${cap(`${raw} | ${r.stderr}`.trim(), 300)}`,
   stdout: "",
   exitCode: r.exitCode,
   durationMs: r.durationMs,
  };
 }
 try {
  return {
   json: JSON.parse(raw.slice(brace)),
   reason: null,
   stdout: raw,
   exitCode: r.exitCode,
   durationMs: r.durationMs,
  };
 } catch (e) {
  return {
   json: null,
   reason: `probe JSON unparsable (${String((e as any)?.message ?? e)}): ${cap(raw, 200)}`,
   stdout: cap(raw, 2000),
   exitCode: r.exitCode,
   durationMs: r.durationMs,
  };
 }
}

async function apiProbe(ep: any, baseUrl: string | null): Promise<VerifyItem> {
 const method = String(ep?.method ?? "GET").toUpperCase();
 let raw = String(ep?.url ?? "");
 if (!/^https?:\/\//i.test(raw)) {
  const base = (baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  raw = `${base}${raw.startsWith("/") ? raw : `/${raw}`}`;
 }
 const expectStatus = Number.isFinite(Number(ep?.expectStatus))
  ? Number(ep.expectStatus)
  : null;
 const name = scrubSecrets(`${method} ${raw} -> ${expectStatus ?? "<400"}`);
 const keys = Array.isArray(ep?.expectJsonKeys)
  ? ep.expectJsonKeys.map(String)
  : [];
 const maxLatency = Number(ep?.maxLatencyMs ?? 0) || 0;
 const t0 = Date.now();
 try {
  const res = await fetch(raw, {
   method,
   signal: AbortSignal.timeout(
    Math.min(Math.max(maxLatency * 2, 1000), 10000),
   ),
  });
  const latency = Date.now() - t0;
  const body = await res.text().catch(() => "");
  const statusOk = expectStatus === null ? res.status < 400 : res.status === expectStatus;
  let missing: string[] = [];
  if (keys.length) {
   try {
    const j = JSON.parse(body);
    missing = keys.filter(
     (k) => !(j && typeof j === "object" && Object.hasOwn(j, k)),
    );
   } catch {
    missing = keys;
   }
  }
  const latencyOk = !maxLatency || latency <= maxLatency;
  const ok = statusOk && missing.length === 0 && latencyOk;
  const reason = ok
   ? `${res.status} in ${latency}ms${keys.length ? ` (keys ok: ${keys.join(",")})` : ""}`
   : [
     statusOk ? null : `status ${res.status} (expected ${expectStatus ?? "<400"})`,
     missing.length ? `missing json keys: ${missing.join(",")}` : null,
     latencyOk ? null : `latency ${latency}ms > ${maxLatency}ms`,
    ]
     .filter(Boolean)
     .join("; ");
  return {
   name,
   status: ok ? "PASS" : "FAIL",
   reason,
   evidence: {
    command: scrubSecrets(`${method} ${raw}`),
    exitCode: null,
    outputTail: cap(scrubSecrets(ok ? reason : tailOf(body || reason, 500)), 2000),
    artifacts: [],
   },
  };
 } catch (e) {
  const msg = String((e as any)?.message ?? e);
  return {
   name,
   status: "FAIL",
   reason: `request error: ${msg}`,
   evidence: {
    command: scrubSecrets(`${method} ${raw}`),
    exitCode: null,
    outputTail: cap(scrubSecrets(msg), 2000),
    artifacts: [],
   },
  };
 }
}

function loadVisionDefault(): string | null {
 try {
  const p = join(homedir(), ".pi", "agent", "vision-model.json");
  if (!existsSync(p)) return null;
  const m = JSON.parse(readFileSync(p, "utf8"))?.model;
  return typeof m === "string" && m.includes("/") ? m : null;
 } catch {
  return null;
 }
}

// Model pick mirrors vision-handoff.ts (no re-registration of its tools). No usable
// model ⇒ null ⇒ the visual dimension SKIPs; it never silently becomes a pass.
async function pickVisionModel(
 ctx: any,
 cfg: any,
): Promise<{ model: any; via: string } | null> {
 const reg = ctx?.modelRegistry;
 if (!reg || typeof reg.complete !== "function") return null;
 const supportsImage = (m: any) =>
  Array.isArray(m?.input)
   ? m.input.includes("image")
   : String(m?.input ?? "").includes("image");
 const hasAuth = (m: any) => {
  try {
   return typeof reg.hasConfiguredAuth === "function"
    ? !!reg.hasConfiguredAuth(m)
    : true;
  } catch {
   return false;
  }
 };
 const explicit =
  typeof cfg?.visual?.model === "string" && cfg.visual.model.includes("/")
   ? cfg.visual.model
   : loadVisionDefault();
 if (explicit) {
  const slash = explicit.indexOf("/");
  const found =
   typeof reg.find === "function"
    ? reg.find(explicit.slice(0, slash), explicit.slice(slash + 1))
    : undefined;
  if (found && supportsImage(found) && hasAuth(found))
   return { model: found, via: "configured" };
  return null;
 }
 const current = ctx?.model;
 if (current && supportsImage(current) && hasAuth(current))
  return { model: current, via: "current" };
 try {
  const all = await reg.getAvailable();
  const vision = (all ?? []).filter(supportsImage).filter(hasAuth);
  if (vision.length) return { model: vision[0], via: "fallback" };
 } catch {
  // registry unavailable ⇒ no evidence
 }
 return null;
}

const JUDGE_SYSTEM = `You are a strict UI acceptance judge. You see ONE screenshot of the route {ROUTE}.
You do not have the source code. Judge ONLY what is visible.

Criterion-by-criterion. For each criterion below emit exactly one verdict:
  "pass"      — you can point to visible evidence that satisfies it
  "fail"      — you can point to visible evidence that violates it
  "unclear"   — the screenshot does not show enough to decide (cropped, hidden,
                loading, too small, unreadable text)

Criteria:
{CRITERIA}

Rules you must obey:
- For every "pass" and every "fail" you MUST quote the exact text you read in the
  screenshot (verbatim, max 40 chars) in the "observed" field. If you cannot quote
  it, the verdict is "unclear". Never write "observed": null with a pass/fail.
- "fail" MUST also state where: one of top-left | top-center | top-right | middle |
  bottom-left | bottom-center | bottom-right, plus the element you looked at.
- If the page is blank, mid-loading, mostly empty, shows a spinner/skeleton, or the
  text is too small/blurred to read — every criterion is "unclear". A blank or
  unreadable screenshot is NEVER evidence of success.
- Do not infer behaviour, hover states, error handling, or anything not visible.
  Do not judge code quality, performance, accessibility, or backend behaviour.
- Do not reward effort, and do not give the benefit of the doubt. An element that
  is absent is a "fail" for a presence criterion, never "unclear".
- Only report a defect you can locate in the screenshot.

Output ONLY this JSON, no prose before or after:
{
  "route": "<string>",
  "criteria": [
    {"id": "<int>", "criterion": "<string>", "verdict": "pass|fail|unclear",
     "observed": "<verbatim text from the screenshot, or ''>",
     "location": "none|top-left|top-center|top-right|middle|bottom-left|bottom-center|bottom-right",
     "reason": "<one short sentence>"}
  ],
  "defects": [
    {"severity": "blocker|major|minor", "summary": "<string>",
     "location": "<region>", "observed": "<verbatim text or ''>",
     "fix": "<imperative one-line developer instruction>"}
  ],
  "confidence": <float 0..1>,
  "verdict": "pass|fail|unclear"
}

Verdict rule (apply mechanically, do not override): "pass" only if every criterion is
"pass"; "fail" if any criterion is "fail"; otherwise "unclear".`;

function judgePrompt(routePath: string, criteria: string[]): string {
 const list = criteria
  .map((c, i) => `${i + 1}. [atomic, observable] ${c}`)
  .join("\n");
 return JUDGE_SYSTEM.replace("{ROUTE}", routePath).replace("{CRITERIA}", list);
}

function verdictOf(parsed: any): "pass" | "fail" | "unclear" {
 const v = String(parsed?.verdict ?? "").toLowerCase();
 const crit = Array.isArray(parsed?.criteria) ? parsed.criteria : [];
 if (v === "pass" || v === "fail" || v === "unclear") return v as any;
 if (crit.length) {
  if (crit.some((c: any) => String(c?.verdict).toLowerCase() === "fail"))
   return "fail";
  if (crit.every((c: any) => String(c?.verdict).toLowerCase() === "pass"))
   return "pass";
  return "unclear";
 }
 return "unclear";
}

async function judgeShot(
 ctx: any,
 model: any,
 shotAbs: string,
 routePath: string,
 criteria: string[],
 referenceAbs: string | null,
 signal: any,
): Promise<{
 verdict: "pass" | "fail" | "unclear";
 reason: string;
 defects: any[];
}> {
 try {
  const data = readFileSync(shotAbs).toString("base64");
  const content: any[] = [
   { type: "text", text: `Route: ${routePath}` },
   {
    type: "image",
    source: { type: "base64", mediaType: "image/png", data },
   },
  ];
  if (referenceAbs && existsSync(referenceAbs)) {
   const refData = readFileSync(referenceAbs).toString("base64");
   const mime = extname(referenceAbs).toLowerCase() === ".jpg" ? "image/jpeg" : "image/png";
   content.push({ type: "text", text: "Second image: reference (already-approved framing)." });
   content.push({
    type: "image",
    source: { type: "base64", mediaType: mime, data: refData },
   });
  }
  const messages = [{ role: "user", content, timestamp: Date.now() }];
  const context = { systemPrompt: judgePrompt(routePath, criteria), messages };
  let res: any;
  try {
   res = await ctx.modelRegistry.complete(model, context, {
    signal,
    maxTokens: 2000,
    cacheRetention: "none",
    temperature: 0,
   });
  } catch (e) {
   // ponytail: temperature may be unsupported by a provider adapter; retry once without it.
   res = await ctx.modelRegistry.complete(model, context, {
    signal,
    maxTokens: 2000,
    cacheRetention: "none",
   });
   void e;
  }
  const text = (res?.content ?? [])
   .filter((c: any) => c?.type === "text" && c.text)
   .map((c: any) => String(c.text))
   .join("\n")
   .trim();
  const brace = text.indexOf("{");
  if (brace < 0)
   return { verdict: "unclear", reason: "judge returned no JSON", defects: [] };
  let parsed: any;
  try {
   parsed = JSON.parse(text.slice(brace, text.lastIndexOf("}") + 1));
  } catch {
   return { verdict: "unclear", reason: "judge returned non-JSON", defects: [] };
  }
  const defects = Array.isArray(parsed?.defects) ? parsed.defects.slice(0, 10) : [];
  const failing = (Array.isArray(parsed?.criteria) ? parsed.criteria : []).filter(
   (c: any) => String(c?.verdict).toLowerCase() === "fail",
  );
  const reason =
   failing
    .slice(0, 3)
    .map((c: any) => `${c.criterion ?? "criterion"}: ${cap(String(c.observed ?? ""), 60)}`)
    .join("; ") || `verdict ${verdictOf(parsed)}`;
  return { verdict: verdictOf(parsed), reason, defects };
 } catch (e) {
  return {
   verdict: "unclear",
   reason: `judge call failed: ${cap(String((e as any)?.message ?? e), 200)}`,
   defects: [],
  };
 }
}

function writeReport(root: string, report: any): { ok: boolean; reason?: string } {
 try {
  // Last boundary before the report is written: deep-scrub in place so every string that
  // reaches the file (target.url, target.startCommand, evidence tails, nextActions) is
  // redacted, and so the tool text built from the same object matches the file.
  Object.assign(report, scrubDeep(report));
 } catch {
  // best-effort: an unserializable report still gets written
 }
 try {
  const dir = join(root, PI_DIR, "verify");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "shots"), { recursive: true });
  const final = join(dir, "latest.json");
  const tmp = `${final}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(report, null, 2), "utf8");
  renameSync(tmp, final);
  return { ok: true };
 } catch (e) {
  return { ok: false, reason: String((e as any)?.message ?? e) };
 }
}

function slugOf(routePath: string): string {
 return routePath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

function matrixText(report: any, reportNote: string | null, capItems = 8): string {
 const rows = report.dimensions.map(
  (d: any) =>
   `${String(d.name).padEnd(10)} ${String(d.status).padEnd(7)} ${cap(String(d.reason ?? "-"), 120)}`,
 );
 const waivedNames = (report.waived ?? []).map((w: any) => w.dimension);
 const enabledNames = report.dimensions.filter((d: any) => d.enabled).map((d: any) => d.name);
 const next = report.nextActions ?? [];
 const shown = next.slice(0, capItems);
 const lines: string[] = [];
 if (report.escalated)
  lines.push(
   `crew_verify: ESCALATED — ${VERIFY_MAX_ITERATIONS} verify cycles without PASS. Stop and ask the user.`,
  );
 lines.push(
  `crew_verify: ${report.overall} (${Math.round((report.durationMs ?? 0) / 1000)}s) — iteration ${Math.min(Number(report.iteration) || 1, VERIFY_MAX_ITERATIONS)}/${VERIFY_MAX_ITERATIONS} — report: ${reportNote}`,
 );
 lines.push(`project: ${report.project}`);
 lines.push(
  `target: ${report.target?.url ?? "-"} (${report.target?.urlSource ?? "unknown"}; ${report.target?.serverStartedByVerify ? "server started by crew_verify" : "server not started by crew_verify"})`,
 );
 lines.push(
  `fingerprint: ${cap(String(report.sourceFingerprint ?? ""), 15)} (${report.newerSources ?? 0} sources newer than the last report)`,
 );
 lines.push("DIMENSION  STATUS  REASON");
 lines.push(...(rows.length ? rows : ["(no dimension ran)"]));
 lines.push(
  `overall: ${report.overall} (enabled: ${enabledNames.join(", ") || "none"}; waived: ${waivedNames.join(", ") || "none"})`,
 );
 if (shown.length) {
  lines.push(
   `NEXT (fix, then re-run crew_verify; max ${VERIFY_MAX_ITERATIONS} cycles, then escalate to the user):`,
  );
  shown.forEach((a: any, i: number) => {
   lines.push(
    `${i + 1}. [${a.dimension}/${a.severity}] ${cap(String(a.target), 80)} — ${cap(String(a.action), 160)} (evidence: ${cap(String(a.evidence), 160)})`,
   );
  });
 } else {
  lines.push("NEXT: none — no failing evidence.");
 }
 lines.push(
  `HANDOFF: reviewer reads the report + the diff; advisor/synthesizer consume these severities. Artifacts: ${report.artifacts?.length ? `${report.project}/${PI_DIR}/verify/ (${report.artifacts.length} file(s))` : "(none)"}`,
 );
 if (next.length)
  lines.push(
   `Full report (machine-readable): ${report.reportPath ?? "(see console)"} — this text shows ${shown.length} of ${next.length} nextActions.`,
  );
 return cap(scrubSecrets(lines.join("\n")), 12000);
}

function failReport(args: {
 root: string;
 reason: string;
 configPath: string | null;
 configUsed: any;
 startedAt: string;
 iteration?: number;
 escalated?: boolean;
 dimNames?: any;
}): any {
 const fp = { hash: "sha256:unavailable", revision: [], truncated: false };
 // Only the dimensions actually requested may be reported as enabled: the matrix must not
 // claim "enabled: unit, api, ui, visual" for a run that asked for one dimension.
 const req: string[] | null = Array.isArray(args.dimNames)
  ? args.dimNames
    .map(String)
    .filter((d) => (VERIFY_DIMS as readonly string[]).includes(d))
  : null;
 const dims: DimensionResult[] = VERIFY_DIMS.map((d) => ({
  name: d,
  enabled: req ? req.includes(d) : true,
  status: "SKIP" as VerifyStatus,
  reason: args.reason,
  durationMs: 0,
  items: [],
 }));
 return {
  schemaVersion: 1,
  id: `verify-${new Date().toISOString().replace(/[-:.]/g, "")}`,
  createdAt: new Date().toISOString(),
  project: args.root,
  iteration: args.iteration ?? 1,
  maxIterations: VERIFY_MAX_ITERATIONS,
  escalated: !!args.escalated,
  target: { url: null, urlSource: "none", startCommand: null, serverStartedByVerify: false },
  configPath: args.configPath,
  configUsed: args.configUsed,
  sourceFingerprint: fp.hash,
  fingerprintTruncated: false,
  revision: [],
  dimensions: dims,
  overall: "FAIL",
  verifyComplete: false,
  waived: [],
  // A FAIL with no action is an agent dead end: every failReport carries its reason as an action.
  nextActions: [
   {
    dimension: dims.find((d) => d.enabled)?.name ?? VERIFY_DIMS[0],
    severity: "blocker",
    target: "crew_verify",
    action: cap(args.reason, 180),
    evidence: cap(args.reason, 300),
   },
  ],
  timestamps: { startedAt: args.startedAt, finishedAt: new Date().toISOString() },
 };
}

type VerifyOutcome = {
 content: { type: "text"; text: string }[];
 details: any;
};

async function verifyProject(
 params: any,
 signal: any,
 onUpdate: any,
 ctx: any,
): Promise<VerifyOutcome> {
 const startedAtIso = new Date().toISOString();
 const t0 = Date.now();
 try {
  onUpdate?.({ content: [{ type: "text", text: "crew_verify: running…" }] });
 } catch {
  // progress is cosmetic
 }
 const root = resolve(String(params?.project_root ?? ctx?.cwd ?? process.cwd()));
 const roleName = String(params?.project_root ?? ctx?.cwd ?? process.cwd());
 const cfgInput = String(params?.config_path ?? join(PI_DIR, "verify.json"));
 const cfgR = loadConfig(root, cfgInput);
 const cfgPathRel = cfgR.path ? relative(root, cfgR.path) : null;
 const cfg: any = cfgR.cfg;
 const budgetMs = Math.min(
  Math.max(Number(params?.timeout_ms) || Number(cfg.timeoutMs) || 120000, 5000),
  600000,
 );

 const prevPath = join(root, PI_DIR, "verify", "latest.json");
 let prev: any = null;
 try {
  if (existsSync(prevPath)) prev = JSON.parse(readFileSync(prevPath, "utf8"));
 } catch {
  prev = null;
 }
 const sameProject = !!prev && resolve(String(prev.project ?? "")) === root;
 const iteration =
  sameProject && prev?.overall !== "PASS" && Number(prev?.iteration) >= 1
   ? Number(prev.iteration) + 1
   : 1;
 const escalated = iteration > VERIFY_MAX_ITERATIONS;

 let report = failReport({
  root,
  reason: "verification did not run",
  configPath: cfgPathRel,
  configUsed: redactConfig(cfg),
  startedAt: startedAtIso,
  iteration,
  escalated,
  dimNames: params?.dimensions,
 });

 const done = (rep: any, writeErr?: string): VerifyOutcome => {
  // Covers the paths where the report was never written (write failure, unwritable root):
  // the returned text and details are scrubbed from the same object as the file.
  try {
   Object.assign(rep, scrubDeep(rep));
  } catch {
   // best-effort
  }
  rep.durationMs = Date.now() - t0;
  rep.reportPath = writeErr ? null : prevPath;
  const note = writeErr
   ? `NOT WRITTEN (${writeErr}) — treat as unverified`
   : prevPath;
  return {
   content: [{ type: "text", text: matrixText(rep, note) }],
   details: {
    overall: rep.overall,
    reportPath: rep.reportPath,
    iteration: rep.iteration,
    escalated: rep.escalated,
    dimensions: rep.dimensions.map((d: any) => ({
     name: d.name,
     status: d.status,
     reason: d.reason,
    })),
    nextActions: rep.nextActions,
   },
  };
  };

 // Owned by this call only: a server crew_verify spawned is reaped on every exit path.
 let serverPid: number | undefined;

 try {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
   const rep = failReport({
    root,
    reason: `project_root is not a directory: ${roleName}`,
    configPath: cfgPathRel,
    configUsed: null,
    startedAt: startedAtIso,
    dimNames: params?.dimensions,
   });
   return done(rep, "project_root not a directory");
  }

  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();

  const fp = fingerprint(root);
  const prevCreatedMs = prev ? new Date(prev.createdAt ?? 0).getTime() : 0;
  const newerSources = fp.revision.filter((r) => r.mtimeMs > prevCreatedMs).length;

  const waived: { dimension: string; reason: string }[] = (cfg.waivers ?? [])
   .filter((w: any) => w && typeof w === "object")
   .map((w: any) => ({
    dimension: String(w.dimension ?? ""),
    reason: String(w.reason ?? "no reason given"),
   }))
   .filter((w: any) => (VERIFY_DIMS as readonly string[]).includes(w.dimension));
  const waivedNames = new Set(waived.map((w) => w.dimension));

  const reqDims = Array.isArray(params?.dimensions)
   ? params.dimensions.map(String)
   : null;
  const unknownDims = (reqDims ?? []).filter(
   (d: string) => !(VERIFY_DIMS as readonly string[]).includes(d),
  );
  if (unknownDims.length) {
   const rep = failReport({
    root,
    reason: `unknown dimension(s): ${unknownDims.join(", ")} (valid: ${VERIFY_DIMS.join(", ")})`,
    configPath: cfgPathRel,
    configUsed: redactConfig(cfg),
    startedAt: startedAtIso,
    iteration,
    escalated,
    dimNames: reqDims,
   });
   return done(rep, writeReport(root, rep).ok ? undefined : "write failed");
  }

  if (cfgR.reason) {
   const rep = failReport({
    root,
    reason: cfgR.reason,
    configPath: cfgPathRel,
    configUsed: { error: cfgR.reason },
    startedAt: startedAtIso,
    iteration,
    escalated,
    dimNames: reqDims,
   });
   const w = writeReport(root, rep);
   return done(rep, w.ok ? undefined : w.reason);
  }

  const enabledNames: VerifyDim[] = (
   (reqDims ?? cfg.dimensions) as string[]
  ).filter((d: string) => (VERIFY_DIMS as readonly string[]).includes(d)) as VerifyDim[];
  const enabledSet = new Set(enabledNames);

  const urlSources: [any, string][] = [
   [params?.url, "param.url"],
   [cfg.ui?.url, "config.ui.url"],
   [cfg.start?.url, "config.start.url"],
  ];
  let url = "http://localhost:3000";
  let urlSource = "default";
  for (const [candidate, source] of urlSources)
   if (typeof candidate === "string" && candidate) {
    url = candidate;
    urlSource = source;
    break;
   }

  const wantStart: boolean =
   typeof params?.start === "boolean" ? params.start : !!cfg.start;
  let serverStarted = false;
  let uiApiSkip: string | null = null;
  let uiArtifacts: string[] = [];
  let uiShotByRoute: Record<string, string> = {};
  let visualUpload: { model: string; via: string; uploadOk: boolean; judgeCalls: number } | null =
   null;
  // api only needs the base/UI URL for *relative* endpoints: absolute urls (staging, a
  // third-party host) are probed whether or not the UI server answers, so an api-only run is
  // never a silent no-op (R2).
  const apiEndpoints: any[] = Array.isArray(cfg.api?.endpoints) ? cfg.api.endpoints : [];
  const isAbsoluteUrl = (u: any) => /^https?:\/\//i.test(String(u ?? ""));
  const apiHasAbsolute = apiEndpoints.some((e) => isAbsoluteUrl(e?.url));

  if (enabledSet.has("ui") || enabledSet.has("api") || wantStart) {
   if (wantStart && !cfg.start)
    uiApiSkip = "start requested but config declares no start command";
   else if (wantStart && cfg.start) {
    const s = await startDevServer(cfg, root, Math.min(remaining(), 60000));
    serverStarted = s.ok;
    serverPid = s.pid;
    if (!s.ok) uiApiSkip = s.reason;
   }
   if (!uiApiSkip && !serverStarted) {
    const r = await probeUrlOnce(url, 2000);
    if (!r.ok) uiApiSkip = `unreachable: ${url} (${r.reason ?? "no response"})`;
   }
  }

  const dimensions: DimensionResult[] = [];

  // --- unit
  if (enabledSet.has("unit")) {
   const t0d = Date.now();
   const detected =
    Array.isArray(cfg.unit?.commands) && cfg.unit.commands.length
     ? { commands: cfg.unit.commands, searched: ["config unit.commands"] }
     : detectUnitCommands(root);
   if (!detected.commands.length)
    dimensions.push(
     dim(
      "unit",
      "SKIP",
      `no unit test command found; searched: ${detected.searched.join(", ")}`,
      t0d,
      [],
     ),
    );
   else {
    const items = await runScripts(detected.commands, root, "unit", remaining);
    const r = roll(items, "no unit command executed");
    dimensions.push(dim("unit", r.status, r.reason, t0d, items));
   }
  } else
   dimensions.push(
    dim("unit", "SKIP", "not in the requested dimension set", Date.now(), [], false),
   );

  // --- api
  if (enabledSet.has("api")) {
   const t0d = Date.now();
   if (uiApiSkip && !apiHasAbsolute) dimensions.push(dim("api", "SKIP", uiApiSkip, t0d, []));
   else {
    const items: VerifyItem[] = [];
    const cmds =
     Array.isArray(cfg.api?.commands) && cfg.api.commands.length
      ? { commands: cfg.api.commands, searched: ["config api.commands"] }
      : detectApiCommands(root);
    if (cmds.commands.length)
     items.push(...(await runScripts(cmds.commands, root, "api", remaining)));
    const endpoints = Array.isArray(cfg.api?.endpoints) ? cfg.api.endpoints : [];
    for (const ep of endpoints.slice(0, 50)) {
     if (uiApiSkip && !isAbsoluteUrl(ep?.url)) {
      // A relative endpoint has no base to call: that check did not run (a SKIP item keeps
      // the dimension honest without pretending the endpoint failed).
      items.push({
       name: scrubSecrets(String(ep?.url ?? "(endpoint)")),
       status: "SKIP",
       reason: `relative endpoint needs a reachable base url: ${uiApiSkip}`,
       evidence: { command: "", exitCode: null, outputTail: "", artifacts: [] },
      });
      continue;
     }
     if (remaining() < 1500) {
      items.push({
       name: scrubSecrets(String(ep?.url ?? "(endpoint)")),
       status: "SKIP",
       reason: "budget exhausted",
       evidence: { command: "", exitCode: null, outputTail: "", artifacts: [] },
      });
      continue;
     }
     items.push(await apiProbe(ep, url));
    }
    if (!items.length)
     dimensions.push(
      dim(
       "api",
       "SKIP",
       `no api commands or endpoints configured; searched: ${cmds.searched.join(", ")}`,
       t0d,
       [],
      ),
     );
    else {
     const r = roll(items, "no api check executed");
     dimensions.push(dim("api", r.status, r.reason, t0d, items));
    }
   }
  } else
   dimensions.push(
    dim("api", "SKIP", "not in the requested dimension set", Date.now(), [], false),
   );

  // --- ui (Playwright probe; the TS side owns the server, the probe owns only the browser)
  if (enabledSet.has("ui")) {
   const t0d = Date.now();
   if (uiApiSkip) dimensions.push(dim("ui", "SKIP", uiApiSkip, t0d, []));
   else {
    const routes = (
     Array.isArray(cfg.ui?.routes) && cfg.ui.routes.length ? cfg.ui.routes : ["/"]
    )
     .map(String)
     .slice(0, 25);
    // The probe must be able to report its own verdict: give it a deadline with real
    // teardown headroom, and a kill timeout beyond that deadline (a killed probe is
    // silence, which loses the "N/M routes probed" detail).
    const probeDeadlineMs = Math.max(
     Math.min(Number(cfg.ui?.timeoutMs) || 60000, remaining() - 2500),
     2000,
    );
    const probeKillMs = Math.max(probeDeadlineMs + 4000, 3000);
    // clickBudget:0 means "click nothing" — it must not fall back to the default 8.
    const clickBudgetCfg = cfg.ui?.clickBudget;
    const clickBudget = Number.isFinite(Number(clickBudgetCfg))
     ? Math.min(Math.max(Number(clickBudgetCfg), 0), 40)
     : 8;
    const spec = {
     url,
     routes,
     projectRoot: root,
     shotsDir: join(root, PI_DIR, "verify", "shots"),
     viewport: { width: 1280, height: 800 },
     clickBudget,
     // Escape hatches for the non-destructive sweep (R3): routes whose sweep must not run,
     // and visible labels the sweep is allowed to click even though they look destructive.
     clickSkipRoutes: Array.isArray(cfg.ui?.clickSkipRoutes)
      ? cfg.ui.clickSkipRoutes.map(String)
      : [],
     clickAllow: Array.isArray(cfg.ui?.clickAllow) ? cfg.ui.clickAllow.map(String) : [],
     shotsPerRoute: 3,
     actionTimeoutMs: Number(cfg.ui?.actionTimeoutMs) || 5000,
     navTimeoutMs: Number(cfg.ui?.navTimeoutMs) || 15000,
     deadlineMs: probeDeadlineMs,
     expectedText: cfg.ui?.expectedText ?? {},
     expectSelectors: cfg.ui?.expectSelectors ?? {},
     ignoreConsole: Array.isArray(cfg.ui?.ignoreConsole)
      ? cfg.ui.ignoreConsole.map(String)
      : [],
    };
    const specPath = join(root, PI_DIR, "verify", "probe-spec.json");
    const specRel = relative(root, specPath);
    let specErr: string | null = null;
    try {
     mkdirSync(join(root, PI_DIR, "verify"), { recursive: true });
     writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");
    } catch (e) {
     specErr = String((e as any)?.message ?? e);
    }
    if (specErr) dimensions.push(dim("ui", "SKIP", `cannot write probe spec: ${specErr}`, t0d, []));
    else {
     const pr = await runProbe(specPath, probeKillMs);
     const cmd = `python3.14 ui_probe.py --spec ${specRel}`;
     if (!pr.json) {
      // Coverage is reported against the REQUESTED route count: an empty "pages" array must
      // not read as a clean run, and a killed probe must still say what was asked for.
      const noJsonReason = `${pr.reason ?? "probe produced no evidence"} — 0/${routes.length} routes reported (${routes.length} requested)`;
      dimensions.push(
       dim("ui", "SKIP", noJsonReason, t0d, [
        {
         name: "ui_probe.py",
         status: "SKIP",
         reason: noJsonReason,
         evidence: {
          command: cmd,
          exitCode: pr.exitCode,
          outputTail: cap(pr.stdout, 2000),
          artifacts: [],
         },
        },
       ]),
      );
     } else {
      const j = pr.json;
      const pages: any[] = Array.isArray(j.pages) ? j.pages : [];
      const artifacts: string[] = Array.isArray(j.artifacts)
       ? j.artifacts.filter((a: any) => typeof a === "string").slice(0, 50)
       : [];
      const items: VerifyItem[] = [];
      // An overflow note never decides the dimension: it is carried beside the verdict as its
      // own WARN item + action (W5), not as "checks did not run".
      const overflowItems: VerifyItem[] = [];
      for (const pg of pages.slice(0, 50)) {
       const routeName = String(pg?.route ?? "(route)");
       const bits: string[] = [];
       if (pg?.loadError) bits.push(`load error: ${cap(String(pg.loadError), 100)}`);
       if (Number(pg?.httpStatus) >= 400) bits.push(`status ${pg.httpStatus}`);
       if ((pg?.pageErrors ?? []).length)
        bits.push(`pageerror ${cap(String(pg.pageErrors[0]), 80)}`);
       if ((pg?.consoleErrors ?? []).length)
        bits.push(`${pg.consoleErrors.length} console error(s)`);
       if ((pg?.crossOriginFailures ?? []).length)
        bits.push(`${pg.crossOriginFailures.length} cross-origin request(s) failed`);
       if ((pg?.httpErrors ?? []).length)
        bits.push(`${pg.httpErrors.length} http error(s)`);
       if ((pg?.requestFailed ?? []).length)
        bits.push(`${pg.requestFailed.length} failed request(s)`);
       if ((pg?.brokenImages ?? []).length)
        bits.push(`${pg.brokenImages.length} broken image(s)`);
       if (Number(pg?.destructiveSkips) > 0)
        bits.push(`${pg.destructiveSkips} destructive click(s) skipped`);
       if ((pg?.missingText ?? []).length)
        bits.push(`missing text: ${pg.missingText.slice(0, 3).join(", ")}`);
       if ((pg?.missingSelectors ?? []).length)
        bits.push(`missing selector: ${pg.missingSelectors.slice(0, 3).join(", ")}`);
       const clicks: any[] = Array.isArray(pg?.clicks) ? pg.clicks : [];
       const dead = clicks.filter((c: any) => c?.result === "dead-click").length;
       const clickErrors = clicks.filter((c: any) => c?.result === "error").length;
       if (dead) bits.push(`${dead} dead click(s)`);
       if (clickErrors) bits.push(`${clickErrors} click error(s)`);
       const pageStatus: VerifyStatus = String(pg?.status) === "FAIL" ? "FAIL" : "PASS";
       const shot = typeof pg?.screenshot === "string" ? pg.screenshot : null;
       if (shot) uiShotByRoute[routeName] = shot;
       items.push({
        name: routeName,
        status: pageStatus,
        reason: bits.length ? bits.join("; ") : "clean (no fail signal)",
        evidence: {
         command: cmd,
         exitCode: pr.exitCode,
         outputTail: cap(JSON.stringify(pg), 2000),
         artifacts: shot ? [shot] : [],
        },
       });
       if (Number(pg?.overflowX) > 1)
        overflowItems.push({
         name: `${routeName} (overflow)`,
         status: "WARN",
         reason: `horizontal overflow ${pg.overflowX}px`,
         evidence: { command: cmd, exitCode: pr.exitCode, outputTail: "", artifacts: shot ? [shot] : [] },
        });
       const consoleErrors: any[] = Array.isArray(pg?.consoleErrors) ? pg.consoleErrors : [];
       if (consoleErrors.length)
        items.push({
         name: `${routeName} (console)`,
         // A caught render/JS error that only reaches console.error is still a broken page.
         status: cfg.ui?.failOnConsoleError === false ? "WARN" : "FAIL",
         reason: `${consoleErrors.length} console error(s): ${cap(String(consoleErrors[0]), 120)}`,
         evidence: { command: cmd, exitCode: pr.exitCode, outputTail: cap(JSON.stringify(consoleErrors.slice(0, 5)), 800), artifacts: [] },
        });
       const crossOrigin: any[] = Array.isArray(pg?.crossOriginFailures)
        ? pg.crossOriginFailures
        : [];
       if (crossOrigin.length)
        items.push({
         name: `${routeName} (cross-origin request failed)`,
         status: "WARN",
         reason: `${crossOrigin.length} cross-origin request(s) failed: ${cap(String(crossOrigin[0]?.[0] ?? ""), 100)} (${cap(String(crossOrigin[0]?.[1] ?? ""), 60)})`,
         evidence: { command: cmd, exitCode: pr.exitCode, outputTail: cap(JSON.stringify(crossOrigin.slice(0, 5)), 800), artifacts: shot ? [shot] : [] },
        });
      }
      const r = roll(items, String(j.reason ?? "probe reported no pages"));
      // Probe-level SKIP/PASS only describes the routes it actually observed: a probe that
      // ran out of time is not evidence for the routes it never visited.
      const deadlineExceeded = !!j.deadlineExceeded;
      // An observed FAIL is never downgraded to SKIP: a probe that ran out of time still saw
      // the failing routes it managed to visit (W1).
      const status: VerifyStatus =
       r.status === "FAIL"
        ? "FAIL"
        : String(j.status) === "SKIP" || deadlineExceeded || r.status === "SKIP"
          ? "SKIP"
          : r.status;
      const deadPages = pages.filter((p: any) => String(p?.status) === "FAIL");
      const noisyPages = pages.filter(
       (p: any) =>
        (Array.isArray(p?.consoleErrors) && p.consoleErrors.length) ||
        (Array.isArray(p?.crossOriginFailures) && p.crossOriginFailures.length),
      );
      const dirtyCount = new Set([...deadPages, ...noisyPages]).size;
      const consoleTotal = pages.reduce(
       (n: number, p: any) =>
        n + (Array.isArray(p?.consoleErrors) ? p.consoleErrors.length : 0),
       0,
      );
      const firstFails = [
       ...deadPages
        .slice(0, 2)
        .map(
         (p: any) =>
          `${p.route}: ${cap(String(p.failSignals ?? ["fail"]).replace(/,/g, "+"), 60)}`,
        ),
       ...noisyPages
        .filter((p: any) => String(p?.status) !== "FAIL")
        .slice(0, 1)
        .map((p: any) => `${p.route}: console/cross-origin noise`),
      ].join("; ");
      const probeSkip = String(j.status) === "SKIP" || deadlineExceeded;
      const reasonParts: string[] = [];
      if (status === "FAIL") {
       reasonParts.push(`${deadPages.length}/${pages.length} routes failed`);
       if (firstFails) reasonParts.push(firstFails);
      } else if (probeSkip) reasonParts.push(String(j.reason ?? "probe skipped"));
      else {
       reasonParts.push(`${pages.length - dirtyCount}/${pages.length} routes clean`);
       if (consoleTotal) reasonParts.push(`${consoleTotal} console error(s)`);
       if (status === "SKIP" && r.reason) reasonParts.push(cap(String(r.reason), 200));
       if (firstFails) reasonParts.push(firstFails);
      }
      // Coverage is always against the REQUESTED route count: a truncated run must never read
      // as "1/1 routes clean".
      if (pages.length < routes.length)
       reasonParts.unshift(`${pages.length}/${routes.length} routes probed (truncated)`);
      const reason = reasonParts.filter(Boolean).join(" — ") || String(r.reason ?? "no ui evidence");
      uiArtifacts = artifacts;
      dimensions.push(dim("ui", status, reason, t0d, items.concat(overflowItems)));
     }
    }
   }
  } else
   dimensions.push(
    dim("ui", "SKIP", "not in the requested dimension set", Date.now(), [], false),
   );

  // --- visual (vision judge over the screenshots the ui probe wrote)
  if (enabledSet.has("visual")) {
   const t0d = Date.now();
   const vroutes = (Array.isArray(cfg.visual?.routes) ? cfg.visual.routes : []).filter(
    (r: any) => r && Array.isArray(r.expect) && r.expect.length,
   );
   if (!vroutes.length)
    dimensions.push(
     dim(
      "visual",
      "SKIP",
      "no written per-route expectations in .pi/verify.json (visual.routes[].expect)",
      t0d,
      [],
     ),
    );
   else if (cfg.visual?.uploadOk === false)
    dimensions.push(
     dim(
      "visual",
      "SKIP",
      "visual.uploadOk=false — screenshots are not uploaded off-machine, so no verdict",
      t0d,
      [],
     ),
    );
   else {
    const picked = await pickVisionModel(ctx, cfg);
    if (!picked)
     dimensions.push(
      dim("visual", "SKIP", "no vision-capable model with configured auth", t0d, []),
     );
    else {
     const shotsDir = join(root, PI_DIR, "verify", "shots");
     const items: VerifyItem[] = [];
     const judgeModel = `${picked.model?.provider ?? "?"}/${picked.model?.id ?? picked.model?.name ?? "?"}`;
     // How many screenshots actually reached the model: a missing/refused reference must not
     // be reported as "screenshots were uploaded" (W8).
     let judgeCalls = 0;
     for (const r of vroutes.slice(0, 20)) {
      const routePath = String(r.path ?? "/");
      // Prefer the path the probe actually wrote (pages[].screenshot) over re-derived slugs.
      const shot =
       uiShotByRoute[routePath] !== undefined
        ? confine(root, uiShotByRoute[routePath])
        : confine(shotsDir, `${slugOf(routePath)}.png`);
      const relShot = shot ? relative(root, shot) : null;
      if (!shot || !existsSync(shot)) {
       items.push({
        name: routePath,
        status: "SKIP",
        reason: `no screenshot at ${relShot ?? "(path escaped the shots dir)"} — run the ui dimension first`,
        evidence: { command: "judge", exitCode: null, outputTail: "", artifacts: [] },
       });
       continue;
      }
      let ref: string | null = null;
      if (typeof r.reference === "string" && r.reference.trim()) {
       const abs = confine(root, r.reference);
       // A declared reference that cannot be resolved is refused, never silently dropped.
       if (!abs || !existsSync(abs)) {
        items.push({
         name: routePath,
         status: "SKIP",
         reason: `reference unavailable: ${r.reference}`,
         evidence: {
          command: "judge",
          exitCode: null,
          outputTail: "",
          artifacts: relShot ? [relShot] : [],
         },
        });
        continue;
       }
       ref = abs;
      }
      const v = await judgeShot(
       ctx,
       picked.model,
       shot,
       routePath,
       r.expect.map(String),
       ref,
       signal,
      );
      judgeCalls += 1;
      const status: VerifyStatus =
       v.verdict === "pass" ? "PASS" : v.verdict === "fail" ? "FAIL" : "SKIP";
      items.push({
       name: routePath,
       status,
       reason: `${v.verdict}: ${v.reason}`,
       evidence: {
        command: `judge ${picked.via}`,
        exitCode: null,
        outputTail: cap(JSON.stringify(v.defects ?? []), 800),
        artifacts: relShot ? [relShot] : [],
       },
      });
     }
     const fails = items.filter((i) => i.status === "FAIL").length;
     const passes = items.filter((i) => i.status === "PASS").length;
     const unclear = items.filter((i) => i.status === "SKIP").length;
     // Claim what happened: the target was known, but the upload only occurred for the routes
     // whose judge call actually ran (W8).
     visualUpload = {
      model: judgeModel,
      via: picked.via,
      uploadOk: judgeCalls > 0,
      judgeCalls,
     };
     const status: VerifyStatus = fails ? "FAIL" : passes && !unclear ? "PASS" : "SKIP";
     const reason = fails
      ? `${fails}/${items.length} route verdicts failed`
      : passes && !unclear
        ? `${passes}/${items.length} route verdicts passed`
        : `judge returned unclear (no evidence) for ${unclear} route(s)`;
     dimensions.push(dim("visual", status, reason, t0d, items));
    }
   }
  } else
   dimensions.push(
    dim("visual", "SKIP", "not in the requested dimension set", Date.now(), [], false),
   );

  // Waivers are explicit and visible; a waived dimension can never be PASS.
  for (const d of dimensions) {
   if (!waivedNames.has(d.name)) continue;
   d.status = "SKIP";
   d.reason = `waived: ${waived.find((w) => w.dimension === d.name)?.reason ?? "no reason"}`;
  }

  const enabledRes = dimensions.filter((d) => d.enabled);
  const anyFail = enabledRes.some((d) => d.status === "FAIL");
  const nonWaived = enabledRes.filter((d) => !waivedNames.has(d.name));
  // Documented rule: FAIL if any enabled dimension FAILs; PASS only when every enabled,
  // non-waived dimension is PASS and at least one such dimension exists; SKIP otherwise
  // (a waiver alone, or an empty request, never becomes a PASS).
  const overall: "PASS" | "FAIL" | "SKIP" = anyFail
   ? "FAIL"
   : nonWaived.length > 0 && nonWaived.every((d) => d.status === "PASS")
     ? "PASS"
     : "SKIP";

  const nextActions: any[] = [];
  // First, so a later slice can never hide the fact that screenshots left the machine. This is
  // a disclosure, not a fix: severity "info" keeps it visible without making a PASS run carry
  // an unfixable action (W7).
  if (visualUpload)
   nextActions.push({
    dimension: "visual",
    severity: "info",
    target: visualUpload.model,
    action:
     visualUpload.judgeCalls > 0
      ? `Screenshots were uploaded to ${visualUpload.model} (picked via ${visualUpload.via}) to judge ${visualUpload.judgeCalls} route(s) — pin visual.model to a provider you trust, or set visual.uploadOk:false to refuse the upload.`
      : `Nothing was uploaded: ${visualUpload.model} (picked via ${visualUpload.via}) was the intended judge target, but no judge call ran (no usable screenshot/reference), so no screenshot left the machine.`,
    evidence: `${visualUpload.model} (${visualUpload.via}, judgeCalls=${visualUpload.judgeCalls})`,
   });
  for (const d of dimensions) {
   if (!d.enabled) continue;
   // A waiver is the resolution for that dimension: its FAIL/WARN/SKIP items must not
   // emit blocker/major actions. At most one `info` note records the waiver (B5).
   if (waivedNames.has(d.name)) {
    nextActions.push({
     dimension: d.name,
     severity: "info",
     target: `${d.name} dimension`,
     action: `Waived: ${cap(String(d.reason ?? "waived"), 180)}`,
     evidence: cap(String(d.reason ?? ""), 300),
    });
    continue;
   }
   for (const it of d.items) {
    if (it.status !== "FAIL") continue;
    const art = (it.evidence?.artifacts ?? []).join(", ");
    nextActions.push({
     dimension: d.name,
     severity: "blocker",
     target: cap(it.name, 120),
     action: `Fix ${cap(it.name, 80)}: ${cap(it.reason, 180)}`,
     evidence: cap(
      art ? `${it.evidence?.outputTail ?? ""} | ${art}` : (it.evidence?.outputTail || it.reason),
      300,
     ),
    });
   }
   // WARN items never fail a dimension, but they must reach the action list.
   for (const it of d.items) {
    if (it.status !== "WARN") continue;
    nextActions.push({
     dimension: d.name,
     severity: "major",
     target: cap(it.name, 120),
     action: `Investigate ${cap(it.name, 80)}: ${cap(it.reason, 180)}`,
     evidence: cap(it.evidence?.outputTail || it.reason, 300),
    });
   }
   // A SKIP dimension is missing evidence, not a pass: it needs an action — unless it is
   // waived (the waiver is the resolution) or its own items already produced one (an
   // item-level action covers the same ground; W11).
   if (
    d.status === "SKIP" &&
    !waivedNames.has(d.name) &&
    !d.items.some((it) => it.status === "FAIL" || it.status === "WARN")
   )
    nextActions.push({
     dimension: d.name,
     severity: "major",
     target: `${d.name} dimension`,
     action: `No evidence for ${d.name}: ${cap(String(d.reason ?? "skipped"), 180)}`,
     evidence: cap(String(d.reason ?? ""), 300),
    });
  }

  // Every FAIL/SKIP must carry at least one action: a verdict with no next step is a dead
  // end for the agent (W6/W10).
  if (overall !== "PASS" && !nextActions.length)
   nextActions.push({
    dimension: enabledRes[0]?.name ?? "unit",
    severity: overall === "FAIL" ? "blocker" : "major",
    target: `crew_verify ${overall}`,
    action: cap(
     `No dimension produced passing evidence (${enabledRes.map((d) => `${d.name}=${d.status}`).join(", ") || "no dimension was requested"})`,
     180,
    ),
    evidence: cap(
     enabledRes.map((d) => `${d.name}: ${d.status} (${d.reason ?? ""})`).join(" | ") ||
      "no dimension was requested",
     300,
    ),
   });

  report = {
   schemaVersion: 1,
   id: `verify-${new Date().toISOString().replace(/[-:.]/g, "")}`,
   createdAt: new Date().toISOString(),
   project: root,
   iteration,
   maxIterations: VERIFY_MAX_ITERATIONS,
   escalated,
   target: {
    url,
    urlSource,
    startCommand: cfg.start
     ? `${cfg.start.command} ${(cfg.start.args ?? []).join(" ")}`.trim()
     : null,
    serverStartedByVerify: serverStarted,
   },
   configPath: cfgPathRel,
   configUsed: redactConfig(cfg),
   sourceFingerprint: fp.hash,
   fingerprintTruncated: fp.truncated,
   revision: fp.revision,
   newerSources,
   dimensions,
   overall,
   verifyComplete: overall === "PASS",
   waived,
   artifacts: uiArtifacts,
   visualUpload,
   nextActions: nextActions.slice(0, 20),
   timestamps: { startedAt: startedAtIso, finishedAt: new Date().toISOString() },
  };
  const w = writeReport(root, report);
  return done(report, w.ok ? undefined : w.reason);
 } catch (e) {
  const rep = failReport({
   root,
   reason: `verifier crashed: ${cap(String((e as any)?.stack ?? e), 300)}`,
   configPath: cfgPathRel,
   configUsed: redactConfig(cfg),
   startedAt: startedAtIso,
   iteration,
   escalated,
   dimNames: reqDims,
  });
  const w = writeReport(root, rep);
  return done(rep, w.ok ? undefined : w.reason);
 } finally {
  killGroup(serverPid);
 }
}
export default function (pi: ExtensionAPI) {
 pi.registerTool({
  name: "crew_verify",
  label: "Verify project",
  description:
   "Run the project verification gate over the project's own checks (unit, api, ui, visual) and return a PASS/FAIL/SKIP matrix plus nextActions. Writes .pi/verify/latest.json, never blocks the session. The policy — when to run it, what counts as evidence, the 3-cycle cap — is AGENT.md §5.",
  parameters: Type.Object({
   project_root: Type.Optional(
    Type.String({
     description: "Project root (default ctx.cwd); must be an existing directory",
    }),
   ),
   url: Type.Optional(
    Type.String({
     description:
      "Base URL to probe (default config.start.url, else http://localhost:3000)",
    }),
   ),
   dimensions: Type.Optional(
    Type.Array(Type.String(), {
     description:
      "Subset of unit,api,ui,visual (default: all enabled dims from .pi/verify.json). Dims left out are reported enabled:false + SKIP and cannot block PASS",
    }),
   ),
   config_path: Type.Optional(
    Type.String({
     description:
      "Config file relative to project_root (default .pi/verify.json); must stay inside project_root",
    }),
   ),
   timeout_ms: Type.Optional(
    Type.Number({
     description: "Whole-run budget, clamped 5000-600000 (default 120000)",
    }),
   ),
   start: Type.Optional(
    Type.Boolean({
     description:
      "Start the dev server: default only when config.start exists; true with no config.start => ui/api SKIP with reason",
    }),
   ),
  }),
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
   let outcome: VerifyOutcome;
   const onAbort = () => {
    try {
     killAllGroups();
    } catch {
     // groups already gone
    }
   };
   try {
    signal?.addEventListener?.("abort", onAbort);
   } catch {
    // no signal support
   }
   try {
    outcome = await verifyProject(params ?? {}, signal, onUpdate, ctx);
   } catch (e) {
    // A throw here would fail the tool call in a live session; degrade to a FAIL verdict.
    const root = resolve(String((params as any)?.project_root ?? ctx?.cwd ?? process.cwd()));
    const rep = failReport({
     root,
     reason: `verifier crashed: ${cap(String((e as any)?.stack ?? e), 300)}`,
     configPath: null,
     configUsed: null,
     startedAt: new Date().toISOString(),
     dimNames: (params as any)?.dimensions,
    });
    const w = existsSync(root) && statSync(root).isDirectory() ? writeReport(root, rep) : { ok: false, reason: "project_root not writable" };
    rep.reportPath = w.ok ? join(root, PI_DIR, "verify", "latest.json") : null;
    outcome = {
     content: [
      {
       type: "text",
       text: matrixText(rep, w.ok ? rep.reportPath : `NOT WRITTEN (${w.reason}) — treat as unverified`),
      },
     ],
     details: {
      overall: rep.overall,
      reportPath: rep.reportPath,
      iteration: rep.iteration,
      escalated: rep.escalated,
      dimensions: rep.dimensions.map((d: any) => ({
       name: d.name,
       status: d.status,
       reason: d.reason,
      })),
      nextActions: rep.nextActions,
     },
    };
   } finally {
    try {
     signal?.removeEventListener?.("abort", onAbort);
    } catch {
     // no signal support
    }
   }
   return outcome;
  },
 });
 pi.on("session_shutdown", () => {
  try {
   killAllGroups();
  } catch {
   // nothing to kill
  }
 });
 process.on("exit", () => {
  try {
   killAllGroups();
  } catch {
   // nothing to kill
  }
 });
}
