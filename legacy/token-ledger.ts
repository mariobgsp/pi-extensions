// @ts-nocheck -- Pi loads this host extension through Jiti outside a TypeScript project.
/** Privacy-preserving request, task, tool, and token telemetry. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; reasoning: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
type Task = { taskId: string; sessionId: string; startedAt: number; turns: number; requests: number; toolCalls: number; toolErrors: number; toolOutputChars: number; totals: Usage; ended: boolean };

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex").slice(0, 16);
const sid = (ctx: ExtensionContext): string => { try { return ctx.sessionManager.getSessionId() || "unknown"; } catch { return "unknown"; } };
const chars = (value: unknown): number => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "");

function usage(raw: unknown): Usage | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	const keys = ["input", "input_tokens", "prompt_tokens", "promptTokens", "output", "output_tokens", "completion_tokens", "completionTokens", "cacheRead", "cache_read", "cached_tokens", "cached", "total", "total_tokens", "totalTokens"];
	if (!keys.some((key) => finite(value[key]))) return null;
	const count = (...names: string[]) => { for (const name of names) if (finite(value[name]) && value[name] >= 0 && Number.isInteger(value[name])) return value[name]; return 0; };
	const cost = value.cost && typeof value.cost === "object" ? value.cost as Record<string, unknown> : {};
	const money = (...names: string[]) => { for (const name of names) if (finite(cost[name]) && cost[name] >= 0) return cost[name]; return 0; };
	return {
		input: count("input", "input_tokens", "prompt_tokens", "promptTokens"),
		output: count("output", "output_tokens", "completion_tokens", "completionTokens"),
		cacheRead: count("cacheRead", "cache_read", "cached_tokens", "cached"),
		cacheWrite: count("cacheWrite", "cache_write", "cache_creation_input_tokens", "cacheCreationInputTokens"),
		cacheWrite1h: count("cacheWrite1h", "cache_write_1h", "cacheCreationInputTokens1h"),
		reasoning: count("reasoning", "reasoningTokens", "thinkingTokens"),
		totalTokens: count("total", "total_tokens", "totalTokens"),
		cost: { input: money("input"), output: money("output"), cacheRead: money("cacheRead", "cache_read"), cacheWrite: money("cacheWrite", "cache_write"), total: money("total") },
	};
}

function add(target: Usage, source: Usage): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"] as const) target[key] += source[key];
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += source.cost[key];
}

export default function (pi: ExtensionAPI) {
	const path = process.env.PI_TOKEN_LEDGER_PATH || join(homedir(), ".pi", "agent", "token-usage.jsonl");
	const flag = (name: string): any => pi.getFlag?.(name);
	pi.registerFlag?.("experiment-prompt-dedup", { type: "boolean", description: "Deduplicate byte-identical context files" });
	pi.registerFlag?.("experiment-dynamic-read-only-tools", { type: "boolean", description: "Use read-only tools for Read-only prompts" });
	pi.registerFlag?.("experiment-compaction-keep-tokens", { type: "string", description: "Override compaction keepRecentTokens" });
	const experiments = () => ({ promptDedup: flag("experiment-prompt-dedup") === true, dynamicReadOnlyTools: flag("experiment-dynamic-read-only-tools") === true, compactionKeepTokens: flag("experiment-compaction-keep-tokens") || null });
	const ordinals = new Map<string, number>();
	let task: Task | null = null;

	function write(event: Json): void {
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			appendFileSync(path, `${JSON.stringify({ ts: Date.now(), schemaVersion: 2, ...event })}\n`, "utf8");
			chmodSync(path, 0o600);
		} catch { /* telemetry must not affect the session */ }
	}

	function closeTask(reason: string, ctx: ExtensionContext): void {
		if (!task || task.ended) return;
		task.ended = true;
		write({ type: "task_end", taskId: task.taskId, sessionId: sid(ctx), abandoned: reason !== "settled", durationMs: Date.now() - task.startedAt, turns: task.turns, requests: task.requests, toolCalls: task.toolCalls, toolErrors: task.toolErrors, toolOutputChars: task.toolOutputChars, usage: task.totals, experiments: experiments() });
		task = null;
	}

	pi.on("before_agent_start", async (event: any, ctx: ExtensionContext) => {
		const id = sid(ctx);
		if (task && !task.ended) closeTask("superseded", ctx);
		const settings = experiments();
		let systemPrompt: string | undefined;
		if (settings.promptDedup && Array.isArray(event.systemPromptOptions?.contextFiles)) {
			try {
				const seen = new Set<string>();
				const kept: any[] = [];
				const duplicates: string[] = [];
				for (const file of event.systemPromptOptions.contextFiles) {
					const content = typeof file?.content === "string" ? file.content : readFileSync(file.path, "utf8");
					if (seen.has(content)) duplicates.push(content);
					else { seen.add(content); kept.push(file); }
				}
				if (duplicates.length) {
					systemPrompt = event.systemPrompt;
					for (const content of duplicates) {
						const first = systemPrompt.indexOf(content);
						const second = systemPrompt.indexOf(content, first + content.length);
						if (second >= 0) systemPrompt = systemPrompt.slice(0, second) + systemPrompt.slice(second + content.length);
					}
					event.systemPromptOptions.contextFiles = kept;
					write({ type: "experiment", experiment: "prompt-dedup", removed: duplicates.length });
				}
			} catch { write({ type: "experiment", experiment: "prompt-dedup", error: true }); }
		}
		if (settings.dynamicReadOnlyTools && typeof event.prompt === "string" && event.prompt.startsWith("Read-only:") && Array.isArray(event.systemPromptOptions?.selectedTools)) {
			try {
				event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter((name: string) => ["read", "grep", "find", "ls"].includes(name));
				write({ type: "experiment", experiment: "dynamic-read-only-tools", toolCount: event.systemPromptOptions.selectedTools.length });
			} catch { write({ type: "experiment", experiment: "dynamic-read-only-tools", error: true }); }
		}
		task = { taskId: `${id}:${Date.now()}`, sessionId: id, startedAt: Date.now(), turns: 0, requests: 0, toolCalls: 0, toolErrors: 0, toolOutputChars: 0, totals: emptyUsage(), ended: false };
		write({ type: "task_start", taskId: task.taskId, sessionId: id, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, promptChars: chars(event.prompt), systemPromptChars: chars(systemPrompt ?? event.systemPrompt), experiments: settings });
		if (systemPrompt !== undefined) return { systemPrompt };
	});

	pi.on("before_provider_request", async (event: any, ctx: ExtensionContext) => {
		if (!task || task.ended) return;
		const payload = event.payload && typeof event.payload === "object" ? event.payload : event.request ?? event;
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const tools = Array.isArray(payload.tools) ? payload.tools : [];
		const id = sid(ctx);
		const ordinal = (ordinals.get(id) || 0) + 1;
		ordinals.set(id, ordinal);
		const roleChars: Record<string, number> = {};
		let systemCount = 0;
		for (const message of messages) { const role = message?.role || "unknown"; roleChars[role] = (roleChars[role] || 0) + chars(message); if (role === "system") systemCount++; }
		const stableSystem = messages.slice(0, systemCount).map((message: any) => { if (!message || typeof message !== "object" || !("timestamp" in message)) return message; const { timestamp: _timestamp, ...stable } = message; return stable; });
		const toolNames = tools.map((tool: any) => tool?.name ?? tool?.function?.name ?? "unknown");
		write({ type: "request_layout", taskId: task.taskId, sessionId: id, ordinal, messageCount: messages.length, roleChars, toolCount: tools.length, toolNames, toolDefinitionChars: tools.reduce((sum: number, tool: any) => sum + chars(tool), 0), payloadChars: chars(payload), stablePrefixHash: hash({ tools, systemMessages: stableSystem }), systemHash: hash(stableSystem), toolHash: hash(tools), experiments: experiments() });
	});

	pi.on("turn_start", async () => { if (task && !task.ended) task.turns++; });
	pi.on("message_end", async (event: any) => {
		if (!task || task.ended || event.message?.role !== "assistant") return;
		task.requests++;
		const parsed = usage(event.message.usage);
		if (!parsed) { write({ type: "model_request", taskId: task.taskId, sessionId: task.sessionId, usageAvailable: false, stopReason: event.message.stopReason }); return; }
		add(task.totals, parsed);
		write({ type: "model_request", taskId: task.taskId, sessionId: task.sessionId, provider: event.message.provider, model: event.message.model, responseId: event.message.responseId ?? null, stopReason: event.message.stopReason, cacheReadRatio: parsed.input + parsed.cacheRead > 0 ? parsed.cacheRead / (parsed.input + parsed.cacheRead) : 0, usage: parsed, experiments: experiments() });
	});
	pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
		if (!task || task.ended) return;
		task.toolCalls++;
		if (event.isError) task.toolErrors++;
		let outputChars = 0;
		if (Array.isArray(event.content)) outputChars = event.content.reduce((sum: number, block: any) => sum + (block.type === "text" ? chars(block.text) : 0), 0);
		task.toolOutputChars += outputChars;
		const nested = usage(event.usage);
		if (nested) add(task.totals, nested);
		write({ type: "tool_result", taskId: task.taskId, sessionId: sid(ctx), tool: event.toolName, isError: event.isError, outputChars, nestedUsage: nested });
	});
	pi.on("session_before_compact", async (event: any) => {
		const keep = Number(flag("experiment-compaction-keep-tokens"));
		const settings = event?.preparation?.settings;
		if (Number.isSafeInteger(keep) && keep > 0 && settings) { const original = settings.keepRecentTokens; settings.keepRecentTokens = keep; write({ type: "experiment", experiment: "compaction-keep-tokens", original, effective: keep }); }
	});
	pi.on("session_compact", async (event: any, ctx: ExtensionContext) => { const entry = event?.compactionEntry || event?.entry || {}; write({ type: "compaction", sessionId: sid(ctx), usage: entry.usage ?? event?.usage ?? null, reason: event?.reason ?? null, tokensBefore: entry.tokensBefore ?? event?.tokensBefore ?? null, ok: event?.ok !== false && event?.success !== false && event?.error === undefined }); });
	pi.on("agent_settled", async (_event: any, ctx: ExtensionContext) => closeTask("settled", ctx));
}
