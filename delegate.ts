/**
 * delegate — build the one background subagent call for a read-heavy goal.
 *
 * Why this exists: the old fixed crew ran up to seven children in waves. Every
 * wave was a barrier, so wall-clock time was the sum of each role's slowest
 * child, and each child re-derived context the one before it had just read. One
 * child with the main agent's own tools does the same work without the barriers.
 *
 * Why it is this small: a child pays a fixed floor the parent never pays — its
 * own system prompt, its tool definitions, its task text — and pays that floor
 * again on every turn it takes. Inline work pays nothing extra; it just grows
 * the parent's context permanently. So the floor is only worth paying for
 * read-heavy work, and this tool emits a call and nothing else: no report file,
 * no directory, no level heuristic. The parent writes the goal, the facts and
 * the level.
 *
 * `context: "fresh"` is the token decision. The child starts with no view of
 * this conversation, which is why `facts` is a parameter and not a courtesy:
 * what the child cannot infer, the parent writes down. An empty facts means the
 * child works blind and says so in Summary.concerns.
 *
 * The subagent tool ignores its own `thinking` parameter on dispatch
 * (pi-subagents src/extension/schemas.js:293 — "Dispatch ignores this; use model
 * suffix"), so the level rides as a model suffix and resolveEffectiveThinking
 * (src/shared/model-info.js:21) reads it ahead of the agent's frontmatter.
 *
 * ExtensionContext has no callTool, so this tool cannot launch the child. It
 * resolves the model string and the task text and returns the exact call to run,
 * unedited.
 *
 * async: true is what makes `tools: inherit` work at all: a foreground child
 * never loads the parent's ambient extensions, so the agent resolves to a child
 * with no tools and says so on stderr. Never hand this call to async: false.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CHILD_AGENT = "delegate";
const SUBAGENT_TOOL = "subagent";
const DEFAULT_LEVEL = "medium";

/** "provider/id" from whatever shape the context hands us, with any suffix removed. */
function modelIdOf(model: any): string | null {
 if (!model) return null;
 const id = typeof model === "string" ? model : `${model.provider ?? ""}/${model.id ?? model.name ?? ""}`;
 const slash = id.lastIndexOf("/");
 const colon = id.lastIndexOf(":");
 if (colon > slash) return id.slice(0, colon);
 return id.includes("/") ? id : null;
}

export default function (pi: ExtensionAPI) {
  // Activate `subagent` before the FIRST request, not on first use. Tool
  // definitions are serialized before the messages, so adding one mid-session
  // invalidates the entire cached prefix — measured at +18,385 chars of tool
  // schema on a session's first delegation. Registering it up front costs those
  // same tokens on every request instead, but as a cached read (~10x cheaper,
  // and no re-read): the cheaper side for any session longer than ~17 turns.
  //
  // It runs in `before_agent_start`, NOT at load: `setActiveTools` ignores names
  // that are not registered yet (docs/extensions.md:184), and `subagent` belongs
  // to pi-subagents, which may load after this extension. The hook fires once
  // all extensions are registered and before any request goes out, and the
  // guard makes it a no-op on every turn after the first.
  const activateSubagent = (): void => {
    try {
      if (!pi.getActiveTools().includes(SUBAGENT_TOOL)) {
        pi.setActiveTools([...pi.getActiveTools(), SUBAGENT_TOOL]);
      }
    } catch {
      // no active-tool API here: the run() path below still activates on demand
    }
  };
  pi.on("before_agent_start", activateSubagent);

  pi.registerTool({
  name: "delegate",
  label: "Delegate",
  description:
   "Hand one read-heavy goal to a background subagent and get back the exact call to run. Use it when the work needs many files read, a large diff, or a parallel investigation. Do not use it for a greeting, a one-line answer, or a single obvious edit — those are cheaper inline, and inline is the default. The child starts in a fresh context with no view of this conversation, so facts carries what it cannot infer on its own. thinking defaults to medium: minimal for trivial work, high for auth, db, payment, security, migration, concurrency or crypto, xhigh and max only when you mean it. Returns the exact subagent call, unedited.",
  parameters: Type.Object({
   goal: Type.String({ description: "One-sentence task goal (required)." }),
   facts: Type.Optional(
    Type.String({
     description:
      "What the child cannot infer by itself: files already located, decisions already made, conventions already observed. The child sees only its goal and these facts.",
    }),
   ),
   thinking: Type.Optional(
    Type.Union(
     [Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
      Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")],
     { description: "Child thinking level, carried as a model suffix. Defaults to medium." },
    ),
   ),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
   const goal = String(params.goal ?? "").trim();
   if (!goal)
    return { content: [{ type: "text", text: "delegate needs a goal." }], details: { error: "no-goal" } };

   const level = String(params.thinking ?? DEFAULT_LEVEL);
   const facts = String(params.facts ?? "").trim();

   const modelId = modelIdOf((ctx as any)?.model);
   if (!modelId)
    return {
     content: [{ type: "text", text: `delegate: cannot read the current model from the session context, so I cannot build the ":${level}" model string. Pass the subagent call by hand with an explicit model.` }],
     details: { error: "no-model", level },
    };

   const task = [
    `GOAL: ${goal}`,
    `FACTS: ${facts || "(none given — read the files before assuming anything)"}`,
    "Return the Summary object. No report file.",
   ].join("\n");

   // The subagent tool ships inactive. Run what we return and it has to exist.
   let activated = false;
   try {
    if (!pi.getActiveTools().includes(SUBAGENT_TOOL)) {
     pi.setActiveTools([...pi.getActiveTools(), SUBAGENT_TOOL]);
     activated = true;
    }
   } catch {
    // if this fails the call below is still correct, just not yet callable
   }

   const model = `${modelId}:${level}`;
   const call = `subagent { agent: ${JSON.stringify(CHILD_AGENT)}, task: ${JSON.stringify(task)}, model: ${JSON.stringify(model)}, context: "fresh", async: true }`;
   const text = [
    `delegate: ${JSON.stringify(goal)}`,
    `thinking: ${level} — carries as model ${model}`,
    ...(activated ? ["activated the subagent tool; it is live on your next request."] : []),
    "Run exactly this, unedited — the child runs in the background and its completion lands in this conversation:",
    `  ${call}`,
   ].join("\n");

   return { content: [{ type: "text", text }], details: { goal, facts, level, model, task, call } };
  },
 });
}
