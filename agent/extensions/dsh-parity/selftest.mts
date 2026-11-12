/**
 * Assert-based checks for the pure helpers. Run with `node selftest.mts`.
 * No pi runtime, no model, no session.
 */

import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dshParity from "../dsh-parity.ts";
import { asJson, canonicalize, isMutatingBash, pruneTextBlocks, repeatKey } from "./lib.ts";

// Canonicalization ignores key order and keeps array order.
// AssertionFailed: every check below throws before the ok line prints.
assert.equal(canonicalize(asJson({ b: 1, a: [2, 1] })), '{"a":[2,1],"b":1}');
assert.equal(repeatKey("bash", asJson({ command: "ls", timeout: 1 })), repeatKey("bash", asJson({ timeout: 1, command: "ls" })));
assert.notEqual(repeatKey("bash", asJson({ command: "ls" })), repeatKey("read", asJson({ command: "ls" })));

// Oversized text keeps head and tail and reports the omitted span.
const long = "a".repeat(9000);
const pruned = pruneTextBlocks([{ type: "text", text: long }]);
assert.ok(pruned, "9000 chars must prune");
assert.ok(pruned.content[0].type === "text");
assert.ok(pruned.content[0].text.startsWith("a".repeat(4096)));
assert.ok(pruned.content[0].text.endsWith("a".repeat(1024)));
assert.ok(pruned.content[0].text.includes("characters pruned"));
assert.equal(pruned.removedChars, 9000 - 4096 - 1024);

// Within budget and image-bearing results are left alone.
assert.equal(pruneTextBlocks([{ type: "text", text: "short" }]), null);
assert.equal(
	pruneTextBlocks([
		{ type: "text", text: long },
		{ type: "image", data: "AA==", mimeType: "image/png" },
	]),
	null,
);

// Mutation detection: destructive and write-shaped commands block; reads do not.
for (const command of ["rm -rf build", "echo hi > out.txt", "git commit -m x", "npm install", "sed -i s/a/b/ f"]) {
	assert.equal(isMutatingBash(command), true, `expected mutating: ${command}`);
}
for (const command of ["ls -la", "git status --short", "rg 'foo' src", "cat file.txt"]) {
	assert.equal(isMutatingBash(command), false, `expected read-only: ${command}`);
}

// Background-job discipline is added only when the job tools exist.
function rulesFor(toolNames: string[]): string[] {
	const handlers = new Map<string, (event: unknown) => void>();
	// SAFETY: the fake implements only the members dshParity calls while
	// registering handlers and running before_agent_start; every other
	// ExtensionAPI member is unused in this test.
	const pi = {
		on(event: string, handler: (event: unknown) => void) {
			handlers.set(event, handler);
		},
		getAllTools: () => toolNames.map((name) => ({ name })),
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	dshParity(pi);
	const before = handlers.get("before_agent_start") as
		| ((event: { systemPromptOptions: { selectedTools: string[]; promptGuidelines: string[]; sections: Record<string, string> } }) => void)
		| undefined;
	assert.ok(before, "before_agent_start handler must register");
	const options = {
		selectedTools: ["read", "bash", "edit", "write", "codemode"],
		promptGuidelines: [] as string[],
		sections: {} as Record<string, string>,
	};
	before({ systemPromptOptions: options });
	return options.promptGuidelines;
}

const withJobs = rulesFor(["bash", "read", "edit", "write", "codemode", "bg_run", "bg_logs", "bg_kill"]);
assert.ok(withJobs.some((rule) => rule.includes("Track every background task id")));
const withoutJobs = rulesFor(["bash", "read", "edit", "write", "codemode"]);
assert.ok(!withoutJobs.some((rule) => rule.includes("Track every background task id")));

console.log("dsh-parity selftest: ok");
