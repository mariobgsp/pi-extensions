/**
 * browser-auto — autonomous browser thin-client.
 *
 * Registers ~11 thin tools that POST {op,params} to a persistent Python
 * HTTP daemon (server.py, stdlib http.server only) on 127.0.0.1:<port>/rpc.
 * The daemon owns one browser + one persistent context + one page.
 *
 * Engine: browser_launch accepts engine 'playwright' (default) | 'nodriver'.
 * Playwright is fully implemented; nodriver is a stub that returns a clear
 * NOT-IMPLEMENTED error with a pip install hint.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_PY = join(dirname(fileURLToPath(import.meta.url)), "server.py");
const LOCKFILE = join(homedir(), ".cache", "pi-browser", "daemon.json");

let proc: ChildProcess | undefined;
let port = 0;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			const p = typeof addr === "object" && addr ? addr.port : 0;
			s.close(() => resolve(p));
		});
	});
}

async function health(p: number): Promise<boolean> {
	try {
		const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(2000) });
		return r.ok;
	} catch {
		return false;
	}
}

function spawnDaemon(p: number): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const trySpawn = (cmd: string) => {
			const child = spawn(cmd, [SERVER_PY, "--port", String(p)], {
				 detached: true,
				// ponytail: ignore stdio so a chatty daemon can never block on a full pipe
				stdio: ["ignore", "ignore", "ignore"],
			});
			child.once("error", (err: Error) => {
				if (cmd === "python3.14") trySpawn("python3"); // fallback binary
				else reject(err);
			});
			child.once("spawn", () => resolve(child));
		};
		trySpawn("python3.14");
	});
}

function readLockfile(): { port: number; pid?: number } | undefined {
	try {
		const raw = readFileSync(LOCKFILE, "utf8");
		const j = JSON.parse(raw) as { port?: unknown; pid?: unknown };
		if (typeof j.port !== "number" || !j.port) return undefined;
		return { port: j.port, pid: typeof j.pid === "number" ? j.pid : undefined };
	} catch {
		return undefined;
	}
}

async function ensureDaemon(): Promise<number> {
	if (port && (await health(port))) return port;
	// Stale-lockfile reaping: reuse the daemon recorded by another session.
	const prev = readLockfile();
	if (prev && (await health(prev.port))) {
		port = prev.port;
		return port;
	}
	if (prev?.pid) {
		try {
			process.kill(prev.pid, "SIGTERM");
		} catch {
		/* stale pid, already gone */
		}
	}
	const p = await freePort();
	proc = await spawnDaemon(p);
	const deadline = Date.now() + 10_000;
	while (!(await health(p))) {
		if (Date.now() > deadline) throw new Error(`browser-auto daemon failed to start (port ${p})`);
		await new Promise((r) => setTimeout(r, 250));
	}
	port = p;
	try {
		mkdirSync(dirname(LOCKFILE), { recursive: true });
		writeFileSync(LOCKFILE, JSON.stringify({ port: p, pid: proc.pid }));
	} catch {
		/* lockfile is advisory */
	}
	return port;
}

function killDaemon() {
	try {
		if (proc?.pid) process.kill(-proc.pid, "SIGTERM"); // whole process group
	} catch {
		/* already gone */
	}
	try {
		unlinkSync(LOCKFILE);
	} catch {
		/* no lockfile */
	}
	proc = undefined;
	port = 0;
}

async function rpc(op: string, params: Record<string, unknown>, signal?: AbortSignal) {
	const p = await ensureDaemon();
	const r = await fetch(`http://127.0.0.1:${p}/rpc`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ op, params }),
		signal,
	});
	const data = (await r.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
	if (!data.ok) throw new Error(typeof data.error === "string" ? data.error : `op ${op} failed`);
	return data;
}

const ok = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	details: data as Record<string, unknown>,
});
const err = (e: unknown) => ({
	content: [{ type: "text" as const, text: `browser-auto error: ${e instanceof Error ? e.message : String(e)}` }],
	isError: true as const,
});

function tool(
	name: string,
	label: string,
	description: string,
	parameters: ReturnType<typeof Type.Object>,
	op: string,
	pickParams: (params: Record<string, unknown>) => Record<string, unknown> = (p) => p,
) {
	return { name, label, description, parameters, op, pickParams };
}

const TOOLS = [
	tool(
		"browser_launch",
		"Launch Browser",
		"Launch (or relaunch) the persistent browser. engine 'playwright' (default) | 'nodriver' (stub, NOT-IMPLEMENTED). headless defaults true. proxy optionally 'http://host:port'. profile optionally overrides the user-data-dir (default ~/.cache/pi-browser/profile).",
		Type.Object({
			engine: Type.Optional(Type.Union([Type.Literal("playwright"), Type.Literal("nodriver")])),
			headless: Type.Optional(Type.Boolean()),
			proxy: Type.Optional(Type.String()),
			profile: Type.Optional(Type.String()),
		}),
		"launch",
	),
	tool(
		"browser_navigate",
		"Navigate Browser",
		"Navigate the persistent page to a URL.",
		Type.Object({ url: Type.String({ description: "URL to open." }) }),
		"navigate",
	),
	tool(
		"browser_snapshot",
		"Snapshot Page",
		"Return accessibility nodes as {ref,role,name,text}. Use refs with fill/click/check/inspect.",
		Type.Object({}),
		"snapshot",
	),
	tool(
		"browser_inspect",
		"Inspect Node",
		"Return detail for one snapshot ref. Take a fresh snapshot first if the ref is unknown.",
		Type.Object({ ref: Type.String({ description: "Node ref from browser_snapshot, e.g. e12." }) }),
		"inspect",
	),
	tool(
		"browser_fill",
		"Fill Field",
		"Fill the field at ref with text. submit=true presses Enter afterwards.",
		Type.Object({
			ref: Type.String(),
			text: Type.String(),
			submit: Type.Optional(Type.Boolean()),
		}),
		"fill",
	),
	tool(
		"browser_click",
		"Click Node",
		"Click the node at ref.",
		Type.Object({ ref: Type.String() }),
		"click",
	),
	tool(
		"browser_check",
		"Check Box",
		"Set checkbox at ref. checked defaults true.",
		Type.Object({ ref: Type.String(), checked: Type.Optional(Type.Boolean()) }),
		"check",
	),
	tool(
		"browser_screenshot",
		"Screenshot Page",
		"Save a screenshot. path defaults to ~/.cache/pi-browser/shot.png.",
		Type.Object({ path: Type.Optional(Type.String()) }),
		"screenshot",
	),
	tool(
		"browser_wait_for",
		"Wait For",
		"Wait for text/url-substring/selector, or page idle when all are omitted. timeout in ms (default 15000).",
		Type.Object({
			text: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			timeout: Type.Optional(Type.Number()),
		}),
		"wait_for",
	),
	tool(
		"browser_wait_for_login",
		"Wait For Login",
		"Blocking HUMAN handoff: poll until the user finishes logging in (url_contains or selector appears), then return. timeout 120-300s (default 180). Never auto-solves captchas — the HUMAN completes them in the headed window.",
		Type.Object({
			timeout: Type.Optional(Type.Number({ description: "Seconds, clamped 120-300. Default 180." })),
			url_contains: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
		}),
		"wait_for_login",
	),
	tool(
		"browser_close",
		"Close Browser",
		"Close the persistent browser. Daemon stays up for the next launch.",
		Type.Object({}),
		"close",
	),
];

export default function (pi: ExtensionAPI) {
	for (const t of TOOLS) {
		pi.registerTool({
			name: t.name,
			label: t.label,
			description: t.description,
			parameters: t.parameters,
			async execute(_toolCallId, params, signal) {
				try {
					const data = await rpc(t.op, t.pickParams(params as Record<string, unknown>), signal);
					return ok(data);
				} catch (e) {
					return err(e);
				}
			},
		});
	}
	for (const ev of ["session_shutdown", "session_end"] as const) {
		try {
			(pi as unknown as { on: (e: string, h: () => void) => void }).on(ev, () => killDaemon());
		} catch {
			/* older pi without this event — process exit hook still applies */
		}
	}
	process.on("exit", killDaemon);
}
