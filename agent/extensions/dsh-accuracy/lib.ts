/**
 * Pure helpers for the dsh-accuracy extension.
 *
 * No pi or TypeBox imports here so the path, instruction and todo rules can be
 * tested under plain Node.
 */

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Instruction file names pi already understands, in precedence order. */
export const INSTRUCTION_FILES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/** Maximum bytes of one nested instruction file injected into the conversation. */
export const MAX_INSTRUCTION_BYTES = 8 * 1024;

/** Maximum bytes of nested instructions injected across one session. */
export const MAX_SESSION_INSTRUCTION_BYTES = 16 * 1024;

/** Resolve a tool path against the session cwd and normalize symlinks when it exists. */
export function absolutePath(filePath: string, cwd: string): string {
	const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

/** The nearest nested instruction file, or undefined when the file is at cwd. */
export function nearestInstructionFile(filePath: string, cwd: string): string | undefined {
	return findInstructionFiles(filePath, cwd)[0];
}

/** Cut UTF-8 text at a byte budget without throwing on a split code point. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return { text, truncated: false };
	return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/** One nested instruction's admission decision under the per-file and session budgets. */
export interface InstructionLimits {
	perFileBytes: number;
	sessionBytes: number;
	usedBytes: number;
	seenPaths: ReadonlySet<string>;
	seenHashes: ReadonlySet<string>;
}

export interface InstructionPlan {
	path: string;
	content: string;
	hash: string;
	bytes: number;
	truncated: boolean;
	budgetExhausted: boolean;
}

/**
 * Decide whether one instruction file is injected. Returns undefined for an
 * already-seen path or identical content; returns a notice-only plan when the
 * session budget is exhausted.
 */
export function planInstruction(
	path: string,
	raw: string,
	limits: InstructionLimits,
): InstructionPlan | undefined {
	if (limits.seenPaths.has(path)) return undefined;
	const hash = createHash("sha256").update(raw).digest("hex");
	if (limits.seenHashes.has(hash)) return undefined;
	const remaining = limits.sessionBytes - limits.usedBytes;
	if (remaining <= 0) {
		return { path, content: "", hash, bytes: 0, truncated: false, budgetExhausted: true };
	}
	const { text, truncated } = truncateUtf8(raw, Math.min(limits.perFileBytes, remaining));
	return { path, content: text, hash, bytes: Buffer.byteLength(text, "utf8"), truncated, budgetExhausted: false };
}

/** Compact elapsed time: 42s, 3m 7s, 2h 5m. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/**
 * Instruction files from the touched file's directory up to, but not including,
 * the session cwd. Nearest first: the more specific instruction wins.
 *
 * A file directly in cwd returns no nested instructions because pi already
 * loaded the cwd and ancestor files at startup.
 */
export function findInstructionFiles(filePath: string, cwd: string): string[] {
	const root = resolve(cwd);
	let dir = dirname(absolutePath(filePath, cwd));
	const found: string[] = [];
	while (dir.startsWith(root + sep)) {
		for (const name of INSTRUCTION_FILES) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) {
				found.push(candidate);
				break;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return found;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
}

/** Trim, reject empty and duplicate items, and keep the model's order. */
export function normalizeTodos(raw: readonly { content: string; status: TodoStatus }[]): TodoItem[] {
	const todos: TodoItem[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const content = item.content.trim();
		if (content.length === 0) throw new Error("todo content must be a non-empty string");
		if (seen.has(content)) throw new Error(`duplicate todo: ${content}`);
		seen.add(content);
		todos.push({ content, status: item.status });
	}
	return todos;
}

/** Render the complete list with counts; this is what the model sees back. */
export function formatTodoList(todos: readonly TodoItem[]): string {
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	for (const item of todos) {
		if (item.status === "pending") pending += 1;
		else if (item.status === "in_progress") inProgress += 1;
		else completed += 1;
	}
	const lines = todos.map((item) => `- [${todoMark(item.status)}] ${item.content}`);
	return `Todo list updated (${todos.length} items: ${pending} pending, ${inProgress} in progress, ${completed} completed):\n${lines.join("\n")}`;
}

function todoMark(status: TodoStatus): string {
	if (status === "completed") return "x";
	if (status === "in_progress") return "~";
	return " ";
}
