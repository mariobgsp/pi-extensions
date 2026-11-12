import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = join(homedir(), ".pi", "agent", "agents");
const MARKER = "## Delegation crew";

// Wave order. Anything unlisted sorts last, so a new agent file still shows up.
const ORDER = [
	"scout",
	"researcher",
	"planner",
	"builder",
	"verifier",
	"reviewer",
	"advisor",
	"synthesizer",
	"delegate",
];

// A turn counts as orchestration when the operator asks for it, or when a child
// already ran. Once armed it stays armed: a mid-run "continue" turn still needs the
// routing table after the context was reset.
const INTENT =
	/\b(orchestrat\w*|sub-?agents?|delegat\w*|crew|fan out|parallel agents?|multi-?agent|spawn (an? )?agents?|wave \d)/i;
const DELEGATE_TOOLS = /^(subagent|bg_delegate|delegate)$/;

type Role = { name: string; thinking: string; job: string };

function frontmatter(file: string): Record<string, string> {
	const out: Record<string, string> = {};
	const lines = readFileSync(file, "utf8").split("\n");
	if (lines[0]?.trim() !== "---") return out;
	for (const line of lines.slice(1)) {
		if (line.trim() === "---") break;
		const m = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(line);
		if (m) out[m[1]!] = m[2]!;
	}
	return out;
}

// The table is derived from the agent files, so a level printed here is the level the
// child actually runs at rather than a copy that can drift from it.
function roles(): Role[] {
	let files: string[] = [];
	try {
		files = readdirSync(AGENT_DIR).filter((f: string) => f.endsWith(".md"));
	} catch {
		return [];
	}
	return files
		.map((f) => frontmatter(join(AGENT_DIR, f)))
		.filter((fm) => Boolean(fm.name))
		.map((fm) => ({
			name: fm.name!,
			thinking: fm.thinking ?? "inherits main",
			job: (fm.description ?? "").split(/[.,;]/)[0]!.slice(0, 58),
		}))
		.sort((a, b) => {
			const ai = ORDER.indexOf(a.name);
			const bi = ORDER.indexOf(b.name);
			const d = (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
			return d !== 0 ? d : a.name.localeCompare(b.name);
		});
}

function block(): string {
	const list = roles().map((r) => `- ${r.name} — ${r.thinking} — ${r.job}`).join("\n");
	return [
		MARKER,
		"",
		"One role per task. A child's Summary is the handoff, so quote it instead of redoing it.",
		"Levels are pinned in the agent files, so pass model only to escalate: append",
		":high for auth, db, payment, security, migration or concurrency work.",
		"",
		list,
		"",
		"Read-only roles first, in parallel when independent:",
		"scout + researcher → planner → builder → verifier → reviewer → synthesizer.",
		"/crew prints this table on demand; /crew off drops it for the session.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let orchestrating = false;

	pi.on("session_start", async () => {
		orchestrating = false;
	});

	// A child that already ran is proof enough; the operator may never have said
	// anything about delegation.
	pi.on("message_end", async (event: { message?: { role?: string; content?: unknown } }) => {
		if (orchestrating || event.message?.role !== "assistant") return;
		const parts = event.message.content;
		if (!Array.isArray(parts)) return;
		for (const part of parts as { type?: string; name?: string }[]) {
			if (part?.type === "toolCall" && part.name && DELEGATE_TOOLS.test(part.name)) {
				orchestrating = true;
				return;
			}
		}
	});

	pi.on("before_agent_start", async (event: { prompt?: string; systemPrompt: string }) => {
		if (INTENT.test(event.prompt ?? "")) orchestrating = true;
		if (!orchestrating) return undefined;
		if (event.systemPrompt.includes(MARKER)) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${block()}` };
	});

	pi.registerCommand("crew", {
		description: "Show the delegation crew: role, pinned thinking level, wave order",
		handler: async (args: string, ctx) => {
			if (/^(off|reset)$/i.test(args.trim())) {
				orchestrating = false;
				ctx.ui.notify("Crew routing off for this session.", "info");
				return;
			}
			ctx.ui.notify(block(), "info");
		},
	});
}
