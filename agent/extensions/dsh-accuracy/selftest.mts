/**
 * Assert-based checks for the dsh-accuracy helpers. Run with `node selftest.mts`.
 * No pi runtime, no model, no session.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	absolutePath,
	findInstructionFiles,
	formatDuration,
	formatTodoList,
	nearestInstructionFile,
	normalizeTodos,
	planInstruction,
	truncateUtf8,
} from "./lib.ts";

const root = mkdtempSync(join(tmpdir(), "dsh-accuracy-"));
try {
	mkdirSync(join(root, "sub", "deep"), { recursive: true });
	writeFileSync(join(root, "sub", "AGENTS.md"), "sub instructions\n");
	writeFileSync(join(root, "sub", "deep", "CLAUDE.md"), "deep instructions\n");
	writeFileSync(join(root, "sub", "deep", "data.txt"), "payload\n");

	// Nearest instruction first, and the cwd's own AGENTS.md is not nested.
	const found = findInstructionFiles(join(root, "sub", "deep", "data.txt"), root);
	assert.deepEqual(found, [join(root, "sub", "deep", "CLAUDE.md"), join(root, "sub", "AGENTS.md")]);
	assert.deepEqual(findInstructionFiles(join(root, "sub", "data.txt"), root), [join(root, "sub", "AGENTS.md")]);
	assert.deepEqual(findInstructionFiles(join(root, "root.txt"), root), []);

	// Paths normalize `./` and symlinks when the file exists.
	assert.equal(absolutePath("./sub/data.txt", root), join(root, "sub", "data.txt"));

	// Durations are compact.
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(187_000), "3m 7s");
	assert.equal(formatDuration(7_500_000), "2h 5m");

	// Todo validation rejects empty and duplicate content; formatting keeps counts.
	assert.deepEqual(normalizeTodos([{ content: "  a  ", status: "pending" }]), [{ content: "a", status: "pending" }]);
	assert.throws(() => normalizeTodos([{ content: " ", status: "pending" }]));
	assert.throws(() =>
		normalizeTodos([
			{ content: "a", status: "pending" },
			{ content: "a", status: "completed" },
		]),
	);
	const rendered = formatTodoList([
		{ content: "a", status: "pending" },
		{ content: "b", status: "in_progress" },
		{ content: "c", status: "completed" },
	]);
	assert.ok(rendered.includes("1 pending, 1 in progress, 1 completed"));
	assert.ok(rendered.includes("- [~] b"));
	assert.ok(rendered.includes("- [x] c"));	// The nearest nested instruction is the only one injected.
	assert.equal(
		nearestInstructionFile(join(root, "sub", "deep", "data.txt"), root),
		join(root, "sub", "deep", "CLAUDE.md"),
	);

	// Truncation is by UTF-8 bytes, not characters.
	assert.deepEqual(truncateUtf8("abcdef", 3), { text: "abc", truncated: true });
	assert.deepEqual(truncateUtf8("abc", 3), { text: "abc", truncated: false });

	// Per-file truncation, duplicate suppression, and the session budget.
	const seenPaths = new Set<string>();
	const seenHashes = new Set<string>();
	const perFile = planInstruction("a.md", "x".repeat(10), {
		perFileBytes: 4,
		sessionBytes: 100,
		usedBytes: 0,
		seenPaths,
		seenHashes,
	});
	assert.ok(perFile);
	assert.equal(perFile.content.length, 4);
	assert.equal(perFile.truncated, true);
	assert.equal(perFile.bytes, 4);
	seenPaths.add("a.md");
	seenHashes.add(perFile.hash);
	assert.equal(
		planInstruction("a.md", "x".repeat(10), { perFileBytes: 4, sessionBytes: 100, usedBytes: 4, seenPaths, seenHashes }),
		undefined,
	);
	assert.equal(
		planInstruction("b.md", "x".repeat(10), { perFileBytes: 4, sessionBytes: 100, usedBytes: 4, seenPaths, seenHashes }),
		undefined,
	);
	const exhausted = planInstruction("c.md", "different", {
		perFileBytes: 4,
		sessionBytes: 10,
		usedBytes: 10,
		seenPaths,
		seenHashes,
	});
	assert.ok(exhausted);
	assert.equal(exhausted.budgetExhausted, true);
	assert.equal(exhausted.bytes, 0);

} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("dsh-accuracy selftest: ok");
