---
name: sinthink
description: Build by graph, the Pi way — four modes (design thinking, design code, design graph, design surface), A/E/R on the code side and C/V/N on the interface side, plus the eleven-question gate. Uses the sinthink tool for template, save, status and check. Use when a feature spans more than a few files, when a change adds a state or an error path, or when the user asks to sinthink, plan a feature, or make the interface and the code agree.
---

# Sinthink (Pi)

**The code is the graph. The surface is the same graph, seen from the other side.**

Two channels per node on the code side: **A** what flows through it, **E** every way it breaks, **R** what it needs to exist. Three on the interface side: **C** what is shown, **V** every way the content can be absent, **N** what must be true before the surface may exist.

A channel you did not enumerate is a defect review will not catch, because nobody wrote it down.

(This is the Pi copy. The portable skill at `~/.agents/skills/sinthink` is the shared one; this file adds the modes, the gate and the tool whose paths only exist in Pi.)

## When this is worth it

- A feature touching more than a handful of files, or one that adds a user-visible state.
- Anything with a failure path a person will meet on a bad day.
- Work you will hand to another agent to finish.

Skip it for throwaway scripts, rename sweeps, one-file fixes. Ceremony has a cost.

## Four modes

One discipline, four registers. Name the mode you are in; each ends when its questions have answers, not when the code compiles.

| mode | side | settles | channels |
|---|---|---|---|
| Design thinking | code, conceptually | the shapes, the happy path as a graph, where it breaks, what each node needs | A E R |
| Design code | code, mechanically | where trust enters, what wraps a node, what must be released, whether R swaps, whether gen is only A | A E R |
| Design graph | interface, conceptually | what this surface shows, what can be absent, what must be true before it exists | C V N |
| Design surface | interface, mechanically | slots, tree, variants, needs, focus, and the state the design forgot | C V N |

Thinking decides the graph. Code proves the graph is in the file. Graph decides the surface. Surface proves the surface is in the component.

## The plan

Stored outside the project: `$SINTHINK_HOME`, or `~/.pi/agent/sinthink/<feature>.json`. Nothing generated this way lands in a commit — no diagram, no run, no plan.

- `sinthink action=template` — skeleton with the enums the validator enforces, and the eleven gate questions.
- `sinthink action=save plan={...}` — validate, then write.
- `sinthink action=status` — every plan and how far it is from decidable.
- `sinthink action=check` — plan vs tree: files, error tags, void states, needs.
- `/sinthink` — print the stored plans with their gate answer by answer.

`save` refuses an undecided channel: empty graph, missing or unknown cardinality, a node without `e` or `r` (write `[]` to state *nothing here can fail*), an edge naming a node that is not in the graph, a surface with no `v`. A missing gate answer is a warning that names the questions left.

`check` verifies each node's file exists and names every tag in its `e`, and that each surface's component names every entry in `v` and `n`. `r` is checked for declaration only — the layer that assembles the node provides it, not the file.

Never write a plan file into the repository; the one exception is a `.sinthink/plan.json` a person deliberately puts there to keep the design next to the code.

```json
{
  "version": 1,
  "feature": "publish-tweet",
  "title": "Publish a tweet",
  "mode": "code",
  "nouns": [{ "name": "Tweet", "kind": "record", "file": "src/domain/tweet.ts" }],
  "graph": {
    "nodes": [
      { "id": "handler", "label": "POST /tweets", "file": "src/http/tweets.ts",
        "a": "Draft → Tweet", "e": ["InvalidBody"], "r": ["TweetRepo"], "cardinality": "one" }
    ],
    "edges": [["handler", "rate"], ["rate", "moderation"]]
  },
  "surfaces": [
    { "id": "composer", "label": "Composer", "component": "src/ui/Composer.tsx",
      "c": "Draft", "v": ["loading", "empty", "partial", "error", "denied"],
      "n": ["signedIn", "mayReply", "replyTarget"] }
  ],
  "gate": { "q1": "…", "q2": "…" }
}
```

Cardinality is one of four: `one` (a single value), `many` (a flow over time), `live` (a subscription that stays open), `cached` (valid for a window, deduplicated). It decides the type in the file, not the styling.

## Order of work

**1. Name the nouns first.** Records, ids, variants, errors. No bare strings across a boundary.

**2. Draw the happy path as a call graph, before any code.** Mark cardinality on each node. If a node is many and you built it as one, the shape is wrong.

**3. Enumerate E second, per node.** Each break point is exactly one of: retry (transient), escape (recoverable, return an alternative), die (invariant violated — not a domain error). Every layer scopes its own E and hands the next layer a domain error. Write `"e": []` to state *nothing here can fail*; omitting the key means you did not decide.

**4. Enumerate R third.** What must be provided before this node can run. If a node needs the world mocked to be tested, the node is doing too much.

**5. One boundary, one decoder.** Untrusted input is decoded once, at the edge it enters; inside, the types are the guarantee. For a field, the same schema produces the label, the constraint and the error sentence.

**6. Layers wrap, they never rewrite.** Retry, timeout, logging, tracing, caching, motion, focus. If removing the layer changes what the reader can learn, the layer was carrying content.

**7. Scope what is acquired.** A connection, a handle, a worker, a modal's focus. Whatever takes focus names the single move that returns it.

**8. Split the gen body from the pipe.** The gen body is A; the pipe is E. Every `yield` is one edge of the graph and nothing else happens there; every error the body can produce is retried, escaped or scoped in the pipe after it. The one exception — two effects with different failure semantics — handles each one's E inline and is marked `divergent strategy`, because the outer pipe cannot tell which yield failed.

**9. Then the surface.** C is what it shows. **V is E, tag for tag** — one designed state per error the graph can fail with. **N is R, proven on the edge**: if a screen is reachable with its needs unmet, the flow graph has a hole. Markup is C, recipe variants are V.

**10. Save the plan, then check it.** A divergence is one of two things and never a third: a defect to fix, or a plan that is now stale. Fix one in the same turn.

## The gate

Eleven answers before the first line of code. Each one names a channel a reviewer would otherwise have to guess.

1. What are the nouns? 2. What is the happy path? 3. Is this node one, many, live or cached? 4. Where can it break — retry, escape or die? 5. What does it need? 6. Where does untrusted data enter, and where is the one place it is decoded? 7. What wraps this node without changing it? 8. What does it acquire that must be released? 9. Does it still run when R is a test layer? 10. Is every absence the surface can show a designed state? 11. Can the surface be reached with its N unmet?

If one answer is missing, that is the next thing you look at — not the next file you edit. Write the answers into the plan.

## Two questions that catch most of it

- **Code:** can this node fail in a way that is not on its E list? The graph is incomplete.
- **Interface:** can this surface render a state the graph cannot name? The interface is lying.

## Honest limits

`check` reads files and matches the tokens you declared. It catches omissions — a declared error nobody mentions, a void state nobody renders, a file that does not exist. It cannot catch a wrong design, a wrong abstraction, or a state that exists only inside a boolean nobody named. And because the same agent usually writes both plan and code, a green check is evidence of consistency, not correctness. The real gate is the human reading the plan before the code exists.
