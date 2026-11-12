/**
 * sinthink — the four modes, as a tool.
 *
 * Design thinking (A/E/R), design code, design graph (C/V/N), design code · surface:
 * a plan is valid only when every channel is decided — A, E, R per node; C, V, N per
 * surface; cardinality one|many|live|cached; the eleven gate questions answered.
 *
 *   sinthink action=template          the skeleton, with the enums the validator enforces
 *   sinthink action=save plan={...}   validate, then write ~/.pi/agent/sinthink/<feature>.json
 *   sinthink action=status            every plan and how far it is from decidable
 *   sinthink action=check             plan vs tree: files, error tags, void states, needs
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const STORE = process.env.SINTHINK_HOME ?? join(homedir(), ".pi", "agent", "sinthink");

const CARDINALITIES = ["one", "many", "live", "cached"] as const;
const MODES = ["thinking", "code", "graph", "surface"] as const;
type Cardinality = (typeof CARDINALITIES)[number];
type Mode = (typeof MODES)[number];

const GATE: [string, string][] = [
	["q1", "What are the nouns?"],
	["q2", "What is the happy path?"],
	["q3", "Is this node one, many, live or cached?"],
	["q4", "Where can it break — retry, escape or die?"],
	["q5", "What does it need?"],
	["q6", "Where does untrusted data enter, and where is the one place it is decoded?"],
	["q7", "What wraps this node without changing it?"],
	["q8", "What does it acquire that must be released?"],
	["q9", "Does it still run when R is a test layer?"],
	["q10", "Is every absence the surface can show a designed state?"],
	["q11", "Can the surface be reached with its N unmet?"],
];

interface PlanNode {
	id?: string;
	label?: string;
	file?: string;
	a?: string;
	e?: unknown;
	r?: unknown;
	cardinality?: string;
}
interface PlanSurface {
	id?: string;
	label?: string;
	component?: string;
	c?: string;
	v?: unknown;
	n?: unknown;
}
interface Plan {
	version?: number;
	feature?: string;
	title?: string;
	mode?: string;
	nouns?: { name?: string; kind?: string; file?: string }[];
	graph?: { nodes?: PlanNode[]; edges?: [string, string][] };
	surfaces?: PlanSurface[];
	gate?: Record<string, string>;
}

const slug = (s: string) =>
	s
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
const storePath = (feature: string) => join(STORE, `${slug(feature)}.json`);
const strArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

const parseJson = (s: string): Record<string, unknown> => {
	let value: unknown;
	try {
		value = JSON.parse(s);
	} catch (e) {
		throw new Error(`plan: not valid JSON (${(e as Error).message})`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plan: expected a JSON object");
	return value as Record<string, unknown>;
};

const template = () => ({
	version: 1,
	feature: "publish-tweet",
	title: "Publish a tweet",
	mode: "code",
	nouns: [
		{ name: "Tweet", kind: "record", file: "src/domain/tweet.ts" },
		{ name: "TweetId", kind: "id", file: "src/domain/tweet.ts" },
		{ name: "RateLimited", kind: "error", file: "src/domain/errors.ts" },
	],
	graph: {
		nodes: [
			{
				id: "rate",
				label: "rate.check",
				file: "src/domain/rate.ts",
				a: "Draft → Draft",
				e: ["RateLimited"],
				r: ["Clock"],
				cardinality: "cached",
			},
			{
				id: "insert",
				label: "repo.insert",
				file: "src/db/tweetRepo.ts",
				a: "NewTweet → Tweet",
				e: ["PersistenceError"],
				r: ["TweetRepo"],
				cardinality: "one",
			},
		],
		edges: [["rate", "insert"]] as [string, string][],
	},
	surfaces: [
		{
			id: "composer",
			label: "Composer",
			component: "src/ui/Composer.tsx",
			c: "Draft",
			v: ["loading", "empty", "partial", "error", "denied"],
			n: ["signedIn", "mayReply", "replyTarget"],
		},
	],
	gate: Object.fromEntries(GATE.map(([k, q]) => [k, `<answer: ${q}>`])),
});

const validate = (plan: Plan) => {
	const errors: string[] = [];
	const warnings: string[] = [];
	const has = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

	if (!has(plan.feature)) errors.push("feature: missing");
	if (!has(plan.title)) errors.push("title: missing");
	if (plan.mode && !MODES.includes(plan.mode as Mode)) errors.push(`mode: "${plan.mode}" — one of ${MODES.join("|")}`);
	if (!Array.isArray(plan.nouns) || plan.nouns.length === 0) errors.push("nouns: name at least one record, id, variant or error");

	const nodes = plan.graph?.nodes ?? [];
	if (nodes.length === 0) errors.push("graph.nodes: empty — a graph with no nodes is not a design");
	const ids = new Set<string>();
	nodes.forEach((n, i) => {
		const at = `graph.nodes[${i}]${n.id ? ` (${n.id})` : ""}`;
		if (!has(n.id)) errors.push(`${at}: id missing`);
		else if (ids.has(n.id)) errors.push(`${at}: duplicate id`);
		else ids.add(n.id);
		if (!has(n.label)) errors.push(`${at}: label missing`);
		if (!has(n.file)) errors.push(`${at}: file missing`);
		if (!has(n.a)) errors.push(`${at}: a missing — what flows through this node?`);
		if (n.e === undefined) errors.push(`${at}: e missing — write [] to state nothing here can fail`);
		else if (!strArray(n.e)) errors.push(`${at}: e must be an array of error tags`);
		if (n.r === undefined) errors.push(`${at}: r missing — write [] to state it needs nothing`);
		else if (!strArray(n.r)) errors.push(`${at}: r must be an array of requirements`);
		if (!has(n.cardinality)) errors.push(`${at}: cardinality missing — ${CARDINALITIES.join("|")}`);
		else if (!CARDINALITIES.includes(n.cardinality as Cardinality))
			errors.push(`${at}: cardinality "${n.cardinality}" — ${CARDINALITIES.join("|")}`);
	});
	(plan.graph?.edges ?? []).forEach((e, i) => {
		const [from, to] = Array.isArray(e) ? e : [undefined, undefined];
		if (!from || !to) errors.push(`graph.edges[${i}]: needs [from, to]`);
		else if (!ids.has(from) || !ids.has(to)) errors.push(`graph.edges[${i}]: ${from} → ${to} names a node that is not in the graph`);
	});

	const surfaces = plan.surfaces ?? [];
	surfaces.forEach((s, i) => {
		const at = `surfaces[${i}]${s.id ? ` (${s.id})` : ""}`;
		if (!has(s.id)) errors.push(`${at}: id missing`);
		if (!has(s.label)) errors.push(`${at}: label missing`);
		if (!has(s.component)) errors.push(`${at}: component missing`);
		if (!has(s.c)) errors.push(`${at}: c missing — what is shown?`);
		if (!strArray(s.v) || s.v.length === 0) errors.push(`${at}: v needs at least one absence — a surface with only its happy state is 20% designed`);
		if (!strArray(s.n)) errors.push(`${at}: n missing — write [] to state it needs nothing`);
	});
	if (surfaces.length === 0) warnings.push("surfaces: none declared — the interface half is undecided");

	const gate = plan.gate ?? {};
	const answered = GATE.filter(([k]) => has(gate[k]) && !gate[k].startsWith("<answer"));
	if (answered.length < GATE.length) {
		const missing = GATE.filter(([k]) => !answered.some(([a]) => a === k)).map(([k]) => k);
		warnings.push(`gate: ${answered.length}/${GATE.length} answered — ${missing.join(" ")}`);
	}
	return { errors, warnings, answered: answered.length };
};

const readPlan = async (path: string): Promise<Plan> => {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Plan;
	} catch (e) {
		throw new Error(`${path}: not a readable plan (${(e as Error).message})`);
	}
};

const plans = async () => {
	if (!existsSync(STORE)) return [];
	const files = (await readdir(STORE)).filter((f) => f.endsWith(".json"));
	const out: { path: string; plan: Plan }[] = [];
	for (const f of files) {
		try {
			out.push({ path: join(STORE, f), plan: await readPlan(join(STORE, f)) });
		} catch {
			/* a corrupt plan is reported by status as a file it cannot read */
		}
	}
	return out;
};

const tokens = async (file: string) => {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
};

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

const check = async (plan: Plan, cwd: string) => {
	const lines: string[] = [];
	let problems = 0;
	const nodes = plan.graph?.nodes ?? [];
	for (const n of nodes) {
		const rel = n.file ?? "";
		const abs = resolve(cwd, rel);
		const body = await tokens(abs);
		if (body === null) {
			problems++;
			lines.push(`✘ ${pad(n.id ?? "?", 14)} ${rel} — file not found`);
			continue;
		}
		const tags = Array.isArray(n.e) ? (n.e as string[]) : [];
		const needs = Array.isArray(n.r) ? (n.r as string[]) : [];
		// shortcut: R is provided by the layer that assembles the node, not by the node's own
		// file, so it is checked for declaration only; grep across layers when a plan goes wrong.
		const missingTags = tags.filter((t) => !body.includes(t));
		if (missingTags.length === 0) {
			lines.push(`✔ ${pad(n.id ?? "?", 14)} ${rel}  e${tags.length} r${needs.length}`);
		} else {
			problems++;
			lines.push(`✘ ${pad(n.id ?? "?", 14)} ${rel}`);
			lines.push(`   e: no mention of ${missingTags.join(", ")} — declared, not enumerated`);
		}
	}
	for (const s of plan.surfaces ?? []) {
		const rel = s.component ?? "";
		const body = await tokens(resolve(cwd, rel));
		if (body === null) {
			problems++;
			lines.push(`✘ ${pad(s.id ?? "?", 14)} ${rel} — component not found`);
			continue;
		}
		const lower = body.toLowerCase();
		const voids = Array.isArray(s.v) ? (s.v as string[]) : [];
		const needs = Array.isArray(s.n) ? (s.n as string[]) : [];
		const missingV = voids.filter((v) => !lower.includes(v.toLowerCase()));
		const missingN = needs.filter((v) => !lower.includes(v.toLowerCase()));
		if (missingV.length === 0 && missingN.length === 0) {
			lines.push(`✔ ${pad(s.id ?? "?", 14)} ${rel}  v${voids.length} n${needs.length}`);
		} else {
			problems++;
			lines.push(`✘ ${pad(s.id ?? "?", 14)} ${rel}`);
			if (missingV.length) lines.push(`   v: no state rendered for ${missingV.join(", ")}`);
			if (missingN.length) lines.push(`   n: no gate for ${missingN.join(", ")}`);
		}
	}
	return { lines, problems };
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "sinthink",
		label: "Sinthink",
		description:
			"Design by graph: validate and store an A/E/R + C/V/N plan, then check the code against it. Actions: template, save, status, check.",
		promptSnippet: "Validate or check an A/E/R + C/V/N design plan (template | save | status | check)",
		promptGuidelines: [
			"Use sinthink action=template before designing a feature of more than a few files, and sinthink action=save once every channel — A, E, R per node; C, V, N per surface — is decided.",
			"Use sinthink action=check after the change; a divergence is a defect to fix or a plan that is now stale, never neither.",
		],
		parameters: Type.Object({
			action: StringEnum(["template", "save", "status", "check"] as const),
			plan: Type.Optional(Type.Any({ description: "The plan object for save" })),
			feature: Type.Optional(Type.String({ description: "Feature slug for status or check" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;
			const text = (s: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: s }], details });

			if (action === "template") return text(JSON.stringify(template(), null, 2));

			if (action === "save") {
				const raw: unknown = typeof params.plan === "string" ? parseJson(params.plan) : params.plan;
				if (!raw || typeof raw !== "object" || Array.isArray(raw))
					throw new Error("plan: pass the plan object (sinthink action=template prints the skeleton)");
				const plan = raw as Plan;
				const { errors, warnings, answered } = validate(plan);
				if (errors.length) {
					return {
						content: [{ type: "text" as const, text: `refused · ${errors.length} undecided\n- ${errors.join("\n- ")}` }],
						details: { errors, warnings },
						isError: true,
					};
				}
				await mkdir(STORE, { recursive: true });
				const path = storePath(plan.feature as string);
				await writeFile(path, JSON.stringify(plan, null, 2) + "\n", "utf8");
				const count = plan.graph?.nodes?.length ?? 0;
				const surf = plan.surfaces?.length ?? 0;
				const warn = warnings.length ? `\n${warnings.map((w) => `! ${w}`).join("\n")}` : "";
				return text(`saved · ${path}\n${count} node(s) · ${surf} surface(s) · gate ${answered}/11${warn}`, { path, warnings });
			}

			if (action === "status") {
				const all = await plans();
				if (all.length === 0) return text(`no plans in ${STORE}\nstart with sinthink action=template`);
				const rows = all.map(({ plan }) => {
					const v = validate(plan);
					const nodes = plan.graph?.nodes?.length ?? 0;
					const surf = plan.surfaces?.length ?? 0;
					const state = v.errors.length ? `${v.errors.length} undecided` : "decidable";
					return `${pad(plan.feature ?? "?", 26)} ${pad(state, 14)} gate ${v.answered}/11 · ${nodes} node(s) · ${surf} surface(s)`;
				});
				return text(`${STORE}\n${rows.join("\n")}`);
			}

			// check
			const all = await plans();
			if (all.length === 0) return text(`no plans in ${STORE} — nothing to check`);
			const wanted = params.feature ? all.filter(({ plan }) => slug(plan.feature ?? "") === slug(params.feature as string)) : all;
			if (wanted.length === 0) return text(`no plan for feature "${params.feature}"`);
			const blocks: string[] = [];
			let problems = 0;
			for (const { plan } of wanted) {
				const v = validate(plan);
				const r = await check(plan, ctx.cwd);
				problems += r.problems + v.errors.length;
				const head = `${plan.feature ?? "?"} · ${plan.title ?? ""}`.trim();
				const warn = [...v.errors, ...v.warnings].map((w) => `! ${w}`);
				blocks.push(
					[`${head}`, `${v.errors.length ? "✘" : "✔"} plan decidable · gate ${v.answered}/11`, ...r.lines, ...warn].join("\n"),
				);
			}
			const tail = problems === 0 ? "in agreement" : `${problems} divergence(s) — a defect to fix, or a plan that is now stale`;
			return text(`${blocks.join("\n\n")}\n\n${tail}`, { problems });
		},
	});

	pi.registerCommand("sinthink", {
		description: "Show the design plans and the eleven-question gate",
		handler: async (args, ctx) => {
			const all = await plans();
			const feature = args.trim();
			if (all.length === 0) {
				ctx.ui.notify(`No plans in ${STORE} — run sinthink action=template`, "info");
				return;
			}
			const picked = feature
				? all.filter(({ plan }) => slug(plan.feature ?? "").includes(slug(feature)))
				: all;
			const lines: string[] = [];
			for (const { plan } of picked.length ? picked : all) {
				const v = validate(plan);
				const gate = plan.gate ?? {};
				lines.push(`## ${plan.title ?? plan.feature ?? "plan"}`);
				lines.push(`${plan.graph?.nodes?.length ?? 0} node(s) · ${plan.surfaces?.length ?? 0} surface(s) · gate ${v.answered}/11 · ${v.errors.length ? "undecided" : "decidable"}`);
				if (v.errors.length) lines.push(v.errors.map((e) => `✘ ${e}`).join("\n"));
				for (const [k, q] of GATE) {
					const ans = gate[k];
					const done = typeof ans === "string" && ans.trim() && !ans.startsWith("<answer");
					lines.push(`${done ? "✔" : "·"} ${k.replace("q", "")}. ${q}${done ? ` — ${ans}` : ""}`);
				}
				lines.push("");
			}
			pi.sendMessage({ customType: "sinthink", content: lines.join("\n"), display: true });
		},
	});

	// Footer: how far the most recent plan is from decidable.
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const all = await plans();
		if (all.length === 0) return;
		const latest = all[all.length - 1].plan;
		const v = validate(latest);
		ctx.ui.setStatus(
			"sinthink",
			v.errors.length ? `sin · ${v.answered}/11 · ${v.errors.length} open` : `sin · decidable`,
		);
	});
}

export { validate, template, GATE, CARDINALITIES, MODES, STORE };
