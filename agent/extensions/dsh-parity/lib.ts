/**
 * Pure helpers for the dsh-parity extensions.
 *
 * No pi imports here: selftest.mts runs this file under plain Node so the
 * pruning, canonicalization and mutation checks can be verified without a
 * model or a session.
 */

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
	[key: string]: unknown;
}

export type ContentBlock = TextBlock | ImageBlock;

export const PRUNE = {
	thresholdChars: 8192,
	headChars: 4096,
	tailChars: 1024,
} as const;

export interface PruneResult {
	content: ContentBlock[];
	removedChars: number;
}

/** The JSON value domain: the only values a tool call's arguments can hold. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Decode untrusted tool arguments into the JSON domain once, at the boundary. */
export function asJson(value: unknown): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) return value.map(asJson);
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const decoded: { [key: string]: JsonValue } = {};
		for (const key of Object.keys(record)) decoded[key] = asJson(record[key]);
		return decoded;
	}
	// undefined, function and symbol cannot come from JSON; keep the diagnostic readable.
	return String(value);
}

/** Code-unit string comparison, locale-independent and deterministic. */
function compareCodeUnits(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/** Deep key-sort so two argument objects that differ only in key order canonicalize the same. */
function sortJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value !== null && typeof value === "object") {
		const sorted: { [key: string]: JsonValue } = {};
		for (const key of Object.keys(value).sort(compareCodeUnits)) {
			sorted[key] = sortJson(value[key] as JsonValue);
		}
		return sorted;
	}
	return value;
}

/** Canonical string form of a tool call's arguments. */
export function canonicalize(value: JsonValue): string {
	return JSON.stringify(sortJson(value));
}

/** Identity of one call: the tool plus its canonical arguments. */
export function repeatKey(toolName: string, input: JsonValue): string {
	return `${toolName}\u0000${canonicalize(input)}`;
}

/**
 * Keep the head and tail of an oversized text result.
 *
 * Returns null when the content is already within budget, when any image block
 * is present, or when slicing would not make it smaller.
 *
 * shortcut: image-bearing results are left untouched because re-ordering image
 * blocks would change what the model sees; upgrade if image-heavy tool results
 * start crowding the context.
 */
export function pruneTextBlocks(
	content: readonly ContentBlock[],
	limits: { thresholdChars: number; headChars: number; tailChars: number } = PRUNE,
): PruneResult | null {
	if (content.some((block) => block.type === "image")) return null; // ImageBlocksPresent: leave image-bearing results untouched.
	const text = content.map((block) => (block.type === "text" ? block.text : "")).join("");
	const points = Array.from(text);
	if (points.length <= limits.thresholdChars) return null;

	const head = points.slice(0, limits.headChars).join("");
	const tail = points.slice(Math.max(0, points.length - limits.tailChars)).join("");
	const removedChars = points.length - Array.from(head).length - Array.from(tail).length;
	const marker = `\n\n[... ${removedChars} characters pruned to fit the context budget; the full result is not retained. Re-run with a narrower query, or use offset/limit when reading a file ...]\n\n`;
	const pruned = head + marker + tail;
	if (pruned.length >= text.length) return null; // PruneOverflow: a slice that does not shrink the text keeps the original.
	return { content: [{ type: "text", text: pruned }], removedChars };
}

const MUTATING_BASH: readonly RegExp[] = [
	// Destructive or write-shaped commands at a command boundary.
	/(^|[;&|]\s*)(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|truncate|dd|tee)\b/,
	/\bsed\s+-i/,
	/\bperl\s+-i/,
	// Repository and dependency mutations.
	/\bgit\s+(commit|checkout|switch|reset|clean|merge|rebase|cherry-pick|apply|am|stash|push|tag)\b/,
	/\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|remove|uninstall|update)\b/,
	/\bpip3?\s+install\b/,
	/\bcargo\s+(add|install)\b/,
	/\bgo\s+get\b/,
	// Output redirection. False positives (a literal '>' in an argument) are
	// accepted: the gate is advisory and /plan-approve releases it.
	/(^|[^>])>(?!>|&)/,
	/>>/,
];

/**
 * Whether a bash command looks like it changes the workspace.
 *
 * Deliberately conservative: a false positive only costs one /plan-approve; a
 * false negative would let plan mode carry out the plan.
 */
export function isMutatingBash(command: string): boolean {
	return MUTATING_BASH.some((pattern) => pattern.test(command));
}
