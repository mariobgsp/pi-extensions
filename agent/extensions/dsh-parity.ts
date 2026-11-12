/**
 * dsh-parity: the loop guards DeepSeek Harness uses, expressed as pi hooks.
 *
 * - Adds the operational rules dsh writes per tool (exit codes, read-before-edit).
 * - Adds dsh's final-answer file-reference contract.
 * - Prunes oversized tool results to a head + tail budget.
 * - Reminds the model after 3/5/8 identical tool calls.
 *
 * Plan mode lives in dsh-plan.ts. PTC mode is the `codemode.mode: "only"` setting,
 * not this file.
 */

import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { asJson, PRUNE, pruneTextBlocks, repeatKey } from "./dsh-parity/lib.ts";

/** Consecutive identical-call counts that earn a reminder. */
const THRESHOLDS = new Set([3, 5, 8]);
const ARGUMENT_PREVIEW_CHARS = 500;

const GENTLE_REMINDER =
	"You are repeating the exact same tool call with identical arguments. " +
	"Carefully analyze the previous result before calling again: if the task is not complete, " +
	"try a different approach or different arguments instead of repeating the call.";

function detailedReminder(toolName: string, count: number, argumentsPreview: string): string {
	return (
		"Repeated tool call detected:\n" +
		`- tool: ${toolName}\n` +
		`- consecutive_calls: ${count}\n` +
		`- arguments: ${argumentsPreview}\n` +
		"The repeated calls are not making progress. Do not call this tool with these exact arguments again. " +
		"Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered."
	);
}

function previewArguments(canonical: string): string {
	if (canonical.length <= ARGUMENT_PREVIEW_CHARS) return canonical;
	return `${canonical.slice(0, ARGUMENT_PREVIEW_CHARS)}… (+${canonical.length - ARGUMENT_PREVIEW_CHARS} more chars)`;
}

const EXIT_CODE_RULE = "Check the exit code on every bash result; investigate failures before moving on.";
const READ_RULE = "Use read to examine files instead of cat or sed.";
const EDIT_RULE = "Read a file before editing it unless you just created or edited it in this session.";
const WRITE_RULE = "Read an existing file before overwriting it with write and prefer edit for targeted changes.";
const CODEMODE_RULE =
	"For multi-step inspection or edits, write one codemode script instead of many separate tool calls; use searchTools or describeTool when a signature is unclear.";
const BACKGROUND_JOBS_RULE =
	"Track every background task id you start. Before giving a final answer, collect every still-relevant task with bg_logs (use bg_wait only when you are genuinely blocked on it), and bg_kill tasks that stopped mattering. Do not leave orphaned tasks running.";

/** dsh's DELIVERABLE_FILE_REFERENCES section, adapted to a terminal-first pi. */
const OUTPUT_CONTRACT = [
	"Output contract:",
	"- Outside commands, configuration expressions, and code blocks, link every mention of an existing file to its full path relative to the working directory or absolute; append #L24 or #L24-L30 for known lines.",
	"- Use the filename or a clear alias as the label, adding only enough parent directories to distinguish files; keep full paths out of labels. When precise locations matter, append :24 or :24–30, with no # or L in the line suffix.",
	"- Enclose Markdown file destinations in angle brackets, especially paths containing spaces.",
	"- Prefer showing the primary result in the final response; use ![Description](<path>) for an image that supports an explanation.",
	"- Keep the final answer short and factual: state what changed, what was verified, and what remains.",
].join("\n");

export default function dshParity(pi: ExtensionAPI): void {
	/** One agent's consecutive-repeat chain. */
	const chains = new Map<string, { key: string; count: number }>();

	const reset = (): void => {
		chains.clear();
	};
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("input", reset);

	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		const rules = options.promptGuidelines;
		const configured = new Set(pi.getAllTools().map((tool) => tool.name));
		const add = (rule: string): void => {
			// RuleConflict: the same rule may arrive from a tool guideline and from
			// this extension; keep one copy so the rules section stays stable.
			if (!rules.includes(rule)) rules.push(rule);
		};

		if (configured.has("bash") || configured.has("codemode")) add(EXIT_CODE_RULE);
		if (configured.has("read")) add(READ_RULE);
		if (configured.has("edit")) add(EDIT_RULE);
		if (configured.has("write")) add(WRITE_RULE);
		if (options.selectedTools.includes("codemode")) add(CODEMODE_RULE);
		if (configured.has("bg_run") && configured.has("bg_logs") && configured.has("bg_kill")) {
			add(BACKGROUND_JOBS_RULE);
		}
		options.sections.output_contract = OUTPUT_CONTRACT;
	});

	pi.on("tool_result", (event, ctx): ToolResultEventResult | undefined => {
		let patch: ToolResultEventResult | undefined;

		// Prune only the model-facing copy of a direct call. A nested codemode
		// result is program data; truncating it would silently change the script's
		// value. Image blocks are left alone (ImageBlocksPresent), and a slice that
		// does not shrink the text keeps the original (PruneOverflow).
		if (event.parentToolCallId === undefined) {
			const pruned = pruneTextBlocks(event.content, PRUNE);
			if (pruned) {
				patch = { content: pruned.content };
				if (event.structuredContent !== undefined) patch.structuredContent = event.structuredContent;
			}
		}

		const key = repeatKey(event.toolName, asJson(event.input));
		const chain = chains.get(key);
		const count = chain === undefined ? 1 : chain.count + 1;
		chains.clear();
		chains.set(key, { key, count });
		if (!THRESHOLDS.has(count)) return patch;

		const text = count === 3 ? GENTLE_REMINDER : detailedReminder(event.toolName, count, previewArguments(key));
		try {
			pi.sendMessage({ customType: "dsh-repeat-reminder", content: text, display: false }, { deliverAs: "steer" });
		} catch (reminderSendFailed) {
			// ReminderSendFailed: a failed nudge must not fail the tool result.
			ctx.ui.setStatus("dsh-parity", `reminder failed: ${String(reminderSendFailed)}`);
		}
		return patch;
	});
}
