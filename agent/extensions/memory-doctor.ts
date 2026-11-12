/**
 * memory-doctor — keeps the memory vault honest and connects sessions to the graph.
 *
 *   health    `memory-lint --brief`, injected as a prompt section only while something
 *             is wrong (a clean vault costs zero tokens)
 *   /memory   the full lint report
 *   graph     whenever a run completes (agent_settled), today's daily note gets one
 *             upserted link line: [[MEMORY]] plus every memory note this session touched
 *   nudge     one line, once per session, when files changed outside the vault and no
 *             note was written — the consolidation prompt
 *
 * The vault is one truth at $PI_MEMORY_DIR / ~/.pi/agent/memory (~/brain).
 * Everything here fails open: a broken vault must never break a session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";

const MEMORY = process.env.PI_MEMORY_DIR ?? join(homedir(), ".pi", "agent", "memory");
const LINT = join(homedir(), ".local", "bin", "memory-lint");
const NOTE_DIRS = ["notes", "maps", "decisions", "lessons", "reviews"];
const TOUCH_TOOLS = new Set(["read", "write", "edit"]);
const EDIT_TOOLS = new Set(["write", "edit"]);
const HEALTH_TTL_MS = 20_000;
// Note paths written through bash (`cat > notes/x.md`) count as touches too.
// Any .md path at all — noteRel() rejects everything outside the vault.
const BASH_MD = /(?:~|\/)[^\s'"`);|&]*\.md/g;

const localDate = () => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const absolute = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const noteRel = (raw: string): string | null => {
	const rel = relative(MEMORY, absolute(raw));
	if (!rel || rel.startsWith("..") || rel === "MEMORY.md" || !rel.endsWith(".md")) return null;
	const [folder, ...rest] = rel.split(sep);
	if (!NOTE_DIRS.includes(folder) || rest.length === 0) return null;
	if (rel.split(sep).includes("daily")) return null;
	return rel;
};

const lint = (args: string[]) =>
	new Promise<string>((resolve) => {
		execFile(LINT, [...args, "--vault", MEMORY], { timeout: 4000 }, (_err, stdout) => resolve((stdout ?? "").trim()));
	});

export default function (pi: ExtensionAPI) {
	let health = "";
	let healthAt = 0;
	let refreshing = false;
	let changed = 0; // writes/edits outside the vault — the signal that work happened
	let nudged = false;
	const touched = new Set<string>();

	const refreshHealth = async () => {
		if (!existsSync(LINT) || !existsSync(MEMORY) || Date.now() - healthAt < HEALTH_TTL_MS || refreshing) return;
		refreshing = true;
		try {
			const out = (await lint(["--brief"])).replace(/^memory: /, "");
			// Only a problem is worth a prompt line; a clean vault stays silent.
			health = /error|warning/.test(out) ? out : "";
			healthAt = Date.now();
		} finally {
			refreshing = false;
		}
	};

	/** Write, then replace, the session's one graph block in today's daily note. */
	const upsertEdge = (sid: string) => {
		if (!existsSync(MEMORY) || touched.size === 0) return;
		const names = new Set(["MEMORY", ...[...touched].map((rel) => basename(rel, ".md"))]);
		const block = `<!-- graph [${sid}] -->\n## Graph\n${[...names].map((n) => `[[${n}]]`).join(" · ")}`;
		const file = join(MEMORY, "daily", `${localDate()}.md`);
		const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
		const previous = new RegExp(`<!-- graph \\[${sid}\\] -->\\n## Graph\\n[^\\n]*`);
		const next = previous.test(existing)
			? existing.replace(previous, block)
			: `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`;
		if (next === existing) return;
		mkdirSync(join(MEMORY, "daily"), { recursive: true });
		writeFileSync(file, next, "utf8");
	};

	const sid = (ctx: { sessionManager: { getSessionId(): string } }) => {
		try {
			return String(ctx.sessionManager.getSessionId()).replace(/[^\w-]/g, "").slice(0, 12) || "unknown";
		} catch {
			return "unknown";
		}
	};

	pi.on("tool_call", (event) => {
		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown })?.command;
			if (typeof command !== "string") return;
			for (const match of command.matchAll(BASH_MD)) {
				const rel = noteRel(match[0]);
				if (rel && existsSync(join(MEMORY, rel))) touched.add(rel);
			}
			return;
		}
		if (!TOUCH_TOOLS.has(event.toolName)) return;
		const path = (event.input as { path?: unknown })?.path;
		if (typeof path !== "string") return;
		const rel = noteRel(path);
		if (rel) touched.add(rel);
		else if (EDIT_TOOLS.has(event.toolName)) changed++;
	});

	// Work completed: the session becomes a node, and consolidation gets a reminder.
	pi.on("agent_settled", (_event, ctx) => {
		try {
			upsertEdge(sid(ctx));
		} catch {
			// a lost edge is a lint note, not a crash
		}
	});

	pi.on("before_agent_start", async (event) => {
		try {
			await refreshHealth();
			const nudge =
				!nudged && changed > 0 && touched.size === 0
					? `memory: ${changed} file(s) changed outside the vault and no note written — capture what must survive, or ignore if routine.`
					: "";
			if (nudge) nudged = true;
			const sections = (event.systemPromptOptions as { sections?: Record<string, string> } | undefined)?.sections;
			if (!sections) return;
			const text = [health && `${health}\nRun \`memory-lint\` for the detail.`, nudge].filter(Boolean).join("\n");
			if (text) sections["memory-health"] = text;
		} catch {
			// never block a run on the vault's health
		}
	});

	pi.registerCommand("memory", {
		description: "Memory vault health: budget, dead links, orphans, unpromoted lessons",
		handler: async (_args, ctx) => {
			if (!existsSync(LINT)) return ctx.ui.notify(`No ${LINT}`, "error");
			const report = (await lint([])) || "memory-lint produced no output";
			pi.sendMessage({ customType: "memory", content: `\`\`\`\n${report}\n\`\`\``, display: true });
		},
	});
}
