// Integration check for crew-routing.ts: loads the real extension, drives the real
// handlers with a stub ExtensionAPI, asserts the routing contract.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import mod from "./crew-routing.ts";

const handlers = new Map();
const commands = new Map();
const pi = {
	on: (event, handler) => handlers.set(event, handler),
	registerCommand: (name, def) => commands.set(name, def),
};
mod(pi);

for (const e of ["session_start", "message_end", "before_agent_start"]) {
	assert.ok(handlers.has(e), `missing handler ${e}`);
}
assert.ok(commands.has("crew"), "missing /crew command");

const BASE = "system prompt under test";
const start = (prompt) => handlers.get("before_agent_start")({ prompt, systemPrompt: BASE });
const assistantToolCall = (name) =>
	handlers.get("message_end")({
		message: { role: "assistant", content: [{ type: "toolCall", name }] },
	});

// 1. neutral turn: nothing injected
assert.equal(await start("fix the failing test"), undefined);

// 2. orchestration intent: block appended, and it names real pinned levels
const hit = await start("orchestrate this across subagents");
assert.ok(hit?.systemPrompt.startsWith(BASE), "base prompt must be preserved");
const block = hit.systemPrompt.slice(BASE.length);
assert.match(block, /## Delegation crew/);
assert.match(block, /- scout — low /);
assert.match(block, /- verifier — medium /);
assert.match(block, /- advisor — xhigh /);
assert.ok(!/- delegate — delegate /.test(block), "thinking column must not repeat the name");

// 3. idempotent: a base that already carries the block is left alone
assert.equal(
	await handlers.get("before_agent_start")({ prompt: "orchestrate again", systemPrompt: hit.systemPrompt }),
	undefined,
);

// 4. a child that already ran arms the session for neutral follow-ups
await assistantToolCall("subagent");
assert.ok((await start("keep going"))?.systemPrompt.includes("## Delegation crew"));

// 5. /crew off clears it, /crew prints it
let notified = "";
const ctx = { ui: { notify: (m) => (notified += m) } };
await commands.get("crew").handler("", ctx);
assert.match(notified, /- planner — high /);
await commands.get("crew").handler("off", ctx);
assert.equal(await start("keep going"), undefined);

// 6. session_start resets the flag
await assistantToolCall("subagent");
handlers.get("session_start")({});
assert.equal(await start("keep going"), undefined);

// 7. the table is derived from the agent files on disk
const { readdirSync } = await import("node:fs");
const files = readdirSync(`${homedir()}/.pi/agent/agents`).filter((f) => f.endsWith(".md"));
assert.equal(block.split("\n").filter((l) => l.startsWith("- ")).length, files.length);

console.log("crew-routing selftest: all assertions passed");
