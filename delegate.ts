/**
 * delegate — one background subagent per task, thinking level assigned by the
 * dispatcher instead of by the caller.
 *
 * Why this exists: the old fixed crew ran up to seven children in waves. Each
 * wave was a barrier, so wall-clock time was the sum of every role's slowest
 * child, and each child re-derived context the previous one had just read. One
 * child with the main agent's own tools does the same work without the barriers.
 *
 * The subagent tool ignores its own `thinking` parameter on dispatch
 * (pi-subagents src/extension/schemas.js:293 — "Dispatch ignores this; use model
 * suffix"), so the level is carried as a model suffix instead. That is read back
 * as the real level from the run record, e.g. "space-bunny-free · thinking
 * minimal", and it beats the agent's frontmatter because
 * resolveEffectiveThinking (src/shared/model-info.js:21) checks the suffix first.
 *
 * ExtensionContext has no callTool, so this tool cannot launch the child itself.
 * It resolves the level, the model string, the report path and the task text,
 * activates the subagent tool if it is not active yet, and returns the exact
 * call to run. One call, unedited.
 *
 * async: true is not a style choice, it is what makes `tools: inherit` work at
 * all: a foreground child never loads the parent's ambient extensions, so the
 * agent resolves to a child with no tools and says so on stderr. Never hand this
 * call to anyone with async: false.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const PI_DIR = ".pi";
const REPORT_DIR = "delegate";
const CHILD_AGENT = "delegate";
const SUBAGENT_TOOL = "subagent";

const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof LEVELS)[number];

// Checked in order; the first bucket with a word-boundary hit wins. A goal that
// matches nothing gets the baseline, because guessing a task is cheap is how you
// hand the model harder work than you thought you were.
const MINIMAL_HINTS = ["typo", "rename", "comment", "wording", "spelling", "docstring"];
const LOW_HINTS = ["docs", "readme", "one-file", "single-file", "cleanup", "whitespace"];
const HIGH_HINTS = ["auth", "login", "password", "token", "secret", "credential", "db",
 "database", "migration", "schema", "billing", "payment", "money", "concurrency", "race",
 "security", "crypto", "encryption"];

// xhigh and max are deliberately unreachable from the heuristic. They cost real
// money per turn and belong to a decision someone makes on purpose.
// HIGH is checked first and wins outright, so "add a comment explaining the auth
// flow" still costs high. That overpays on a rare combination; the alternative
// ordering underpays on every risky fix that happens to contain a cheap word,
// and underpaying is the failure that costs quality rather than money.
const HINT_BUCKETS: { level: Exclude<Level, "xhigh" | "max">; hints: string[] }[] = [
 { level: "high", hints: HIGH_HINTS },
 { level: "minimal", hints: MINIMAL_HINTS },
 { level: "low", hints: LOW_HINTS },
];
// Medium is the baseline, so there is no medium bucket: it is what you get when
// nothing matches. Risk words raise the level, cheap-action words lower it.
const BASELINE: Exclude<Level, "xhigh" | "max"> = "medium";

// Built once: the tool is called often enough that rebuilding eight regexes per
// call is noise, and a global regex would carry lastIndex between calls.
for (const bucket of HINT_BUCKETS)
 (bucket as any).compiled = bucket.hints.map((hint) => ({ hint, re: new RegExp(`\\b${hint}\\b`, "i") }));

function levelFor(goal: string): { level: Level; levelSource: "heuristic"; hint?: string } {
 for (const bucket of HINT_BUCKETS)
  for (const { hint, re } of bucket.compiled) if (re.test(goal)) return { level: bucket.level, levelSource: "heuristic", hint };
 return { level: BASELINE, levelSource: "heuristic" };
}

/** "provider/id" from whatever shape the context hands us, with any suffix removed. */
function modelIdOf(model: any): string | null {
 if (!model) return null;
 const id = typeof model === "string" ? model : `${model.provider ?? ""}/${model.id ?? model.name ?? ""}`;
 const slash = id.lastIndexOf("/");
 const colon = id.lastIndexOf(":");
 if (colon > slash) return id.slice(0, colon);
 return id.includes("/") ? id : null;
}

function withLevel(modelId: string, level: Level): string {
 return `${modelId}:${level}`;
}

function stamp(d = new Date()): string {
 const p = (n: number) => String(n).padStart(2, "0");
 return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function slug(goal: string): string {
 return (
  goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") ||
  "task"
 );
}

export default function (pi: ExtensionAPI) {
 pi.registerTool({
  name: "delegate",
  label: "Delegate",
  description:
   "Hand one non-trivial goal to a single background subagent that has the same tools you do, and pick its thinking level. Use it for a real task (multi-file change, feature, investigation, refactor) — not for a greeting, a one-line answer, or a single obvious edit. Levels: minimal|low|medium|high|xhigh|max. Omit thinking and the level comes from the goal: medium, unless a risk word (auth, db, payment, security, concurrency, …) raises it to high or a cheap-action word (typo, rename, docs, one-file, …) lowers it to low or minimal. Returns the exact subagent call to run, unedited.",
  parameters: Type.Object({
   goal: Type.String({ description: "One-sentence task goal (required)" }),
   thinking: Type.Optional(
    Type.Union(
     [Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
      Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")],
     { description: "Thinking level for the child. Omit to derive it from the goal." },
    ),
   ),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
   const goal = String(params.goal ?? "").trim();
   if (!goal)
    return { content: [{ type: "text", text: "delegate needs a goal." }], details: { error: "no-goal" } };

   const chosen = params.thinking as Level | undefined;
   const derived = levelFor(goal);
   const level = chosen ?? derived.level;
   const levelSource = chosen ? "explicit" : "heuristic";
   const matched = chosen ? null : (derived.hint ?? null);

   const modelId = modelIdOf((ctx as any)?.model);
   if (!modelId)
    return {
     content: [{ type: "text", text: `delegate: cannot read the current model from the session context, so I cannot build the ":${level}" model string. Pass the subagent call by hand with an explicit model.` }],
     details: { error: "no-model", level },
    };

   const root = resolve(String((ctx as any)?.cwd ?? process.cwd()));
   const dir = join(root, PI_DIR, REPORT_DIR);
   try {
    mkdirSync(dir, { recursive: true });
   } catch {
    // the child reports the write failure itself if the directory is not usable
   }
   const reportPath = join(dir, `${stamp()}-${slug(goal)}.md`);
   const model = withLevel(modelId, level);
   const task = `GOAL: ${goal}\n\nWrite your report to exactly ${reportPath}.\nEnd your final message with a 5-line summary.`;

   // The subagent tool ships inactive. Run what we return and it has to exist.
   let activated = false;
   try {
    if (!pi.getActiveTools().includes(SUBAGENT_TOOL)) {
     pi.setActiveTools([...pi.getActiveTools(), SUBAGENT_TOOL]);
     activated = true;
    }
   } catch {
    // if this fails the run line below is still correct, just not yet callable
   }

   const call = `subagent { agent: ${JSON.stringify(CHILD_AGENT)}, task: ${JSON.stringify(task)}, model: ${JSON.stringify(model)}, async: true }`;
   const text = [
    `delegate: ${JSON.stringify(goal)}`,
    `thinking: ${level} (${levelSource}${matched ? `, matched "${matched}"` : ""}) — carries as model ${model}`,
    `report: ${reportPath}`,
    ...(activated ? ["activated the subagent tool; it is live on your next request."] : []),
    "Run exactly this, unedited — the child runs in the background and its completion lands in this conversation:",
    `  ${call}`,
   ].join("\n");

   return {
    content: [{ type: "text", text }],
    details: { goal, level, levelSource, matched, model, reportPath, call },
   };
  },
 });
}
