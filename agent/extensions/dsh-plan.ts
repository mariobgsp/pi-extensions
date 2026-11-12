/**
 * dsh-plan: a real plan gate, stolen from DeepSeek Harness's plan mode.
 *
 * `/plan` enters plan mode. While active, the plan policy is appended to the
 * system prompt and mutations are blocked at `tool_call`, including nested
 * calls a codemode script makes. `/plan-approve` is the only way out; the model
 * cannot approve its own plan. The commands merge the former prompt templates
 * with the gate, so one `/plan` both writes the plan and enforces it.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMutatingBash } from "./dsh-parity/lib.ts";

const ENTRY = "dsh-plan";

const PLAN_POLICY = [
	"You are in plan mode. Stay in plan mode until the user approves with /plan-approve or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and present it again.",
	"",
	"Explore first. Read the code the task touches and every caller, test, fixture, and config it affects. Use read-only investigation: read, grep, ls, static analysis, and tests or builds only to observe results. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.",
	"",
	"Research what the codebase, the standard library, and installed dependencies already provide, and what the platform gives you for free. Resolve discoverable facts by inspection. Ask the user only for choices only they can make, or for material ambiguity that inspection cannot answer. Do not ask where code lives or how current behavior works when you can find out.",
	"",
	"Structure the plan as: Observe — the code, callers, tests, fixtures, and config the task touches. Research — what already exists. Options — viable approaches with their tradeoffs: size, risk, correctness, and edge cases. Gaps — what is missing, what could break, and what you could not verify. Recommendation — the smallest change that fully solves the task, naming exactly the files, callers, tests, fixtures, and config it touches.",
	"",
	"Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.",
	"",
	"Present the complete plan in your reply, starting with a # title. End it with an explicit APPROVED checkpoint: a one-line summary of the recommended change and the note that no implementation happens until the user runs /plan-approve. Do not ask \"should I proceed?\" in prose; the user approves by running /plan-approve. If the plan is rejected, revise it and present it again.",
].join("\n");

const APPROVE_PROMPT =
	"Find the plan written earlier in this conversation by /plan. Re-read it, confirm it has an APPROVED checkpoint, then implement exactly what the plan recommends. Do not expand scope beyond the approved plan.\n\nIf no plan exists, or it looks incomplete, say so and stop — do not start implementing.\n\nAfter implementing, run the relevant tests or a self-check, then summarize what changed, what you skipped, and any remaining risk.";

const BLOCK_FILE =
	"Plan mode is active. Present the plan and stop; the user approves with /plan-approve before any file change.";
const BLOCK_BASH =
	"Plan mode is active and this bash command looks mutating. Run a read-only command, present the plan, and let the user approve with /plan-approve.";

export default function dshPlan(pi: ExtensionAPI): void {
	let active = false;

	const renderStatus = (ctx: ExtensionContext): void => {
		// inactive: undefined clears the status line; active shows the gate.
		ctx.ui.setStatus("dsh-plan", active ? "plan mode" : undefined);
	};

	const restore = (ctx: ExtensionContext): void => {
		try {
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
				const data = entry.data;
				active = typeof data === "object" && data !== null && "active" in data && data.active === true;
			}
		} catch (stateRestoreFailed) {
			// StateRestoreFailed: a damaged log must not leave the gate silently off.
			// restore-failed is reported in the transcript; the status line stays inactive.
			active = false;
			ctx.ui.notify(`dsh-plan: could not restore plan state: ${String(stateRestoreFailed)}`, "warning");
		}
		renderStatus(ctx);
	};

	const setActive = (next: boolean, ctx: ExtensionContext): void => {
		active = next;
		try {
			pi.appendEntry(ENTRY, { active });
		} catch (statePersistFailed) {
			// StatePersistFailed: keep the in-memory gate; only durability is lost.
			ctx.ui.notify(`dsh-plan: could not persist plan state: ${String(statePersistFailed)}`, "warning");
		}
		renderStatus(ctx);
		ctx.ui.notify(
			active
				? "Plan mode on. Investigate and present an APPROVED plan; edits are blocked until /plan-approve."
				: "Plan mode off. Mutations are allowed.",
			"info",
		);
	};

	const send = async (text: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: "followUp" });
		// One-shot modes exit when the command handler returns. Interactive and RPC
		// stay alive, so only print/json keep the handler pending for the new run.
		if (ctx.mode !== "print" && ctx.mode !== "json") return;
		// waitForIdle alone can resolve before the new run starts, so give it a tick
		// to leave idle first.
		for (let tick = 0; tick < 50 && ctx.isIdle(); tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await ctx.waitForIdle();
	};

	pi.on("session_start", (_event, ctx) => restore(ctx)); // session started: the surface exists only after this restore.
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus("dsh-plan", undefined));

	pi.registerCommand("plan", {
		description: "Enter plan mode: investigate, write an APPROVED plan, and block edits until /plan-approve.",
		handler: async (args, ctx) => {
			setActive(true, ctx);
			const task = args.trim();
			await send(task.length > 0 ? task : "Plan the task described in this conversation.", ctx);
		},
	});
	pi.registerCommand("plan-approve", {
		description: "Approve the current plan and implement it.",
		handler: async (_args, ctx) => {
			setActive(false, ctx);
			await send(APPROVE_PROMPT, ctx);
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!active) return;
		// SectionNameInvalid: `plan_mode` matches pi's [a-z][a-z0-9_-]* rule.
		event.systemPromptOptions.sections.plan_mode = PLAN_POLICY;
	});

	pi.on("tool_call", (event) => {
		if (!active) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			// GateBlocked: a file mutation is a designed denial in plan mode.
			return { block: true, reason: BLOCK_FILE };
		}
		if (event.toolName === "bash" && isMutatingBash(event.input.command)) {
			// GateBlocked: a mutating shell command is a designed denial in plan mode.
			return { block: true, reason: BLOCK_BASH };
		}
		return undefined;
	});
}
