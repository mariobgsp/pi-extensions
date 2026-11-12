---
name: sinthink
description: Design and build by graph instead of by accretion — declare the call graph with A/E/R, the surfaces with C/V/N, save the plan with the sinthink tool, and check the code against it. Use when starting a feature of more than a few files, when a change adds a state or an error path, or when the user asks to "sinthink" a design, plan a feature, enumerate states, or make the interface and the code agree.
---

# Sinthink

**The code is the graph. The surface is the same graph, seen from the other side.**

Two channels per node on the code side: **A** what flows through it, **E** every way it breaks, **R** what it needs to exist. Three on the interface side: **C** what is shown, **V** every way the content can be absent, **N** what must be true before the surface may exist.

The point is not the notation. The point is that a channel you did not enumerate is a defect that review will not catch, because nobody wrote it down.

## When this is worth it

- A feature touching more than a handful of files, or one that adds a user-visible state.
- Anything with a failure path that a person will meet on a bad day.
- Work you will hand to someone else, or to another agent, to finish.

Skip it for throwaway scripts, rename sweeps, and one-file fixes. Ceremony has a cost; this method pays back on features with states and edges, and loses on glue.

## The plan

One plan per feature, stored outside the project under `$DSH_HOME/sinthink/`.
Nothing you generate this way lands in a commit — no diagram, no run, no plan.

`sinthink action=template` prints the skeleton, `action=save` stores it (pass
the object as `plan`), `action=status` summarizes, `action=check` compares it
with the tree. Never write a plan file into the repository; the one exception is
a `.sinthink/plan.json` a person deliberately puts there to keep the design next
to the code, which the checker will read too.

```json
{
  "version": 1,
  "feature": "publish-tweet",
  "title": "Publish a tweet",
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
  ]
}
```

## Order of work

**1. Name the nouns first.** Records, ids, variants, errors. You cannot draw the graph until you know what flows through it. No bare strings across a boundary.

**2. Draw the happy path as a call graph, before any code.** Nodes are functions or handlers; edges are data flow. Mark cardinality on each node: `one` (single value), `many` (a flow over time), `live`/`cached` (time-bounded). If a node is many and you built it as one, the shape is wrong and no amount of styling will fix it.

**3. Enumerate E second, per node.** Each break point is exactly one of: retry (transient), escape (recoverable, return an alternative), die (invariant violated — not a domain error). Errors are values in the channel until you truly cannot handle them. Each layer scopes its own E and hands the next layer a domain error, never an implementation one — the handler must never learn that persistence speaks SQL. Write `"e": []` to state *nothing here can fail*; omitting the key means you did not decide.

**4. Enumerate R third.** "We cannot do X if we do not have Y." R is what must be provided before this node can run. If a node needs the world to be mocked to test it, the node is doing too much.

**5. One boundary, one decoder.** Untrusted input is decoded once, at the edge it enters. Inside, the types are the guarantee. For a field, the same schema produces the label, the constraint and the error sentence — validate at the field, not at submit.

**6. Layers wrap, they never rewrite.** Retry, timeout, logging, tracing, caching, motion, focus — they wrap the node. If removing the layer changes what the reader can learn, the layer was carrying content and the thing underneath was underbuilt.

**7. Scope what is acquired.** A connection, a handle, a worker, a modal's focus: acquire and release is structural. Whatever takes focus names the single move that returns it. An overlay with no defined release is a leak.

**8. Then the surface, one row per screen.** C is what it shows. **V is E, tag for tag** — every error the graph can fail with is a designed state here. A surface with one designed state and four undesigned ones is twenty percent designed. **N is R, proven on the edge**: if a screen can be reached without its needs met, the flow graph has a hole, and that is a design bug, not an engineering case.

**9. Save the plan, then check it.** `sinthink action=save`, then `sinthink action=check` after the change. A divergence is one of two things and never a third: a defect to fix, or a plan that is now stale. Fix one of them in the same turn.

## The two questions that catch most of it

- **Code:** can this node fail in a way that is not on its E list? Then the graph is incomplete.
- **Interface:** can this surface render a state the graph cannot name? Then the interface is lying.

## Honest limits

The checker reads files and searches for the tokens you declared. It catches *omissions* — a declared error nobody mentions, a void state nobody renders, a file that does not exist. It cannot catch a wrong design, a wrong abstraction, or a state that exists only inside a boolean nobody named. Those still need a reader.

And because the same agent usually writes both the plan and the code, a green check is evidence of consistency, not correctness. The real gate is the human reviewing the plan before the code exists.
