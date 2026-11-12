/**
 * dsh-accuracy: the remaining model-facing accuracy mechanisms from DeepSeek
 * Harness, added as pi extensions. Nothing here replaces a pi tool; it adds a
 * precondition, context, or one planning tool.
 *
 * - Read-before-edit: block edit/write on an existing file not read this session.
 * - Nested AGENTS.md: inject the nearest workspace instructions on first touch,
 *   bounded by a per-file and per-session byte budget.
 * - Time context: a durable message injected only when the clock refreshes, so
 *   the system prompt never changes and the prefix cache stays warm.
 * - todo_write: a task list for multi-step work.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	absolutePath,
	formatDuration,
	formatTodoList,
	MAX_INSTRUCTION_BYTES,
	MAX_SESSION_INSTRUCTION_BYTES,
	nearestInstructionFile,
	normalizeTodos,
	planInstruction,
	type TodoStatus,
} from "./dsh-accuracy/lib.ts";

// Test hook: DSH_TIME_REFRESH_MS overrides the 10-minute refresh in a test run.
const configuredRefresh = Number(process.env.DSH_TIME_REFRESH_MS);
const TIME_REFRESH_MS =
	Number.isFinite(configuredRefresh) && configuredRefresh > 0 ? configuredRefresh : 10 * 60 * 1000;

interface ToolCallBlock {
	type: "toolCall";
	name: string;
	arguments: unknown;
}

/** The session entry's timestamp, as a number or an ISO string. */
function entryTime(entry: { timestamp?: unknown }): number | undefined {
	const value = entry.timestamp;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** Read a `path` member from a checked object; undefined when absent or not a string. */
function readPath(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("path" in value)) return undefined;
	const path = value.path;
	return typeof path === "string" && path.trim().length > 0 ? path : undefined;
}

function isToolCallBlock(value: unknown): value is ToolCallBlock {
	if (typeof value !== "object" || value === null) return false;
	const record = value as { type?: unknown; name?: unknown };
	return record.type === "toolCall" && typeof record.name === "string";
}

const TODO_STATUS = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]);
const TODO_SCHEMA = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ description: "One concrete step." }),
			status: TODO_STATUS,
		}),
		{ description: "The complete task list; this call replaces the previous list." },
	),
});

export default function dshAccuracy(pi: ExtensionAPI): void {
	const observed = new Set<string>();
	const injected = new Set<string>();
	const injectedHashes = new Set<string>();
	let injectedBytes = 0;
	let timeText = "";
	let timeAt = 0;

	const reset = (): void => {
		observed.clear();
		injected.clear();
		injectedHashes.clear();
		injectedBytes = 0;
		timeText = "";
		timeAt = 0;
	};

	const restore = (ctx: ExtensionContext): void => {
		reset();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
				for (const block of message.content) {
					if (!isToolCallBlock(block)) continue;
					if (block.name !== "read" && block.name !== "write" && block.name !== "edit") continue;
					const path = readPath(block.arguments);
					if (path !== undefined) observed.add(absolutePath(path, ctx.cwd));
				}
			} else if (entry.type === "custom_message" && entry.customType === "dsh-nested-agents") {
				const path = readPath(entry.details);
				if (path === undefined || injected.has(path)) continue;
				injected.add(path);
				const details = entry.details;
				if (typeof details === "object" && details !== null) {
					const record = details as { bytes?: unknown; hash?: unknown };
					if (typeof record.bytes === "number" && Number.isFinite(record.bytes)) injectedBytes += record.bytes;
					if (typeof record.hash === "string") injectedHashes.add(record.hash);
				}
			}
		}
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", reset);

	// Read-before-edit: an existing file must be observed in this session.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
		const filePath = event.input.path;
		if (typeof filePath !== "string" || filePath.trim().length === 0) return undefined;
		const absolute = absolutePath(filePath, ctx.cwd);
		if (observed.has(absolute)) return undefined;
		if (!existsSync(absolute)) return undefined; // a new file needs no prior read
		return {
			block: true,
			reason: `Read the file first: ${filePath}. Use the read tool, then retry the ${event.toolName}.`,
		};
	});

	pi.on("tool_result", (event, ctx): ToolResultEventResult | undefined => {
		if (event.isError) return undefined;
		if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const filePath = readPath(event.input);
		if (filePath === undefined) return undefined;
		const absolute = absolutePath(filePath, ctx.cwd);
		observed.add(absolute);

		const nearest = nearestInstructionFile(absolute, ctx.cwd);
		if (nearest === undefined || injected.has(nearest)) return undefined;
		let raw: string;
		try {
			raw = readFileSync(nearest, "utf8");
		} catch {
			return undefined;
		}
		const plan = planInstruction(nearest, raw, {
			perFileBytes: MAX_INSTRUCTION_BYTES,
			sessionBytes: MAX_SESSION_INSTRUCTION_BYTES,
			usedBytes: injectedBytes,
			seenPaths: injected,
			seenHashes: injectedHashes,
		});
		injected.add(nearest);
		if (plan === undefined) return undefined;
		injectedHashes.add(plan.hash);
		if (plan.budgetExhausted) {
			pi.sendMessage(
				{
					customType: "dsh-nested-agents",
					content: `Workspace instructions at ${nearest} were not injected: the session instruction budget is exhausted. Read that file directly if the task touches this area.`,
					display: false,
					details: { path: nearest, bytes: 0 },
				},
				{ deliverAs: "steer" },
			);
			return undefined;
		}
		injectedBytes += plan.bytes;
		pi.sendMessage(
			{
				customType: "dsh-nested-agents",
				content: `Workspace instructions for ${dirname(nearest)}${plan.truncated ? " (truncated to the session budget)" : ""}:\n\n${plan.content}`,
				display: false,
				details: { path: nearest, bytes: plan.bytes, hash: plan.hash },
			},
			{ deliverAs: "steer" },
		);
		return undefined;
	});

	// Time context: a message only when the clock refreshes, so the system prompt
	// and its prefix cache stay unchanged between refreshes.
	pi.on("before_agent_start", (_event, ctx) => {
		const now = Date.now();
		if (timeText.length > 0 && now - timeAt < TIME_REFRESH_MS) return;
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const formatted = new Intl.DateTimeFormat("en-CA", {
			dateStyle: "medium",
			timeStyle: "medium",
			timeZone: zone,
		}).format(new Date(now));
		let previous: number | undefined;
		const entries = ctx.sessionManager.getEntries();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry === undefined) continue;
			const stamp = entryTime(entry);
			if (stamp !== undefined) {
				previous = stamp;
				break;
			}
		}
		const elapsed = previous === undefined ? "unavailable" : formatDuration(now - previous);
		timeText = `Current time: ${formatted} (${zone}). Elapsed since the previous model-visible message: ${elapsed}.`;
		timeAt = now;
		return {
			message: {
				customType: "dsh-time-context",
				content: `${timeText}\nThis snapshot supersedes earlier time-context messages.`,
				display: false,
			},
		};
	});

	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description:
			"Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. While work remains, keep the todos being worked on in_progress, several only when work runs in parallel. Mark each todo completed as soon as it is done.",
		promptSnippet: "Record and update a task list to plan multi-step work",
		promptGuidelines: [
			"Use todo_write before starting multi-step work; add one todo per concrete step and mark each completed as soon as it is done.",
		],
		parameters: TODO_SCHEMA,
		async execute(_toolCallId, params) {
			const todos = normalizeTodos(params.todos as { content: string; status: TodoStatus }[]);
			return {
				content: [{ type: "text", text: formatTodoList(todos) }],
				details: { todos },
			};
		},
	});
}
