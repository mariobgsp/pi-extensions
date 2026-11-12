---
name: memory
description: The memory vault — write, link, consolidate and promote memory in the Obsidian vault at ~/.pi/agent/memory (~/brain). Use whenever a durable fact, preference, decision, defect or lesson appears, when the user says "remember this", when memory looks stale or contradictory, or at the end of work worth recalling. Covers the note format, the MEMORY.md budget, the RSI loop and memory-lint.
---

# Memory vault

One truth: `~/.pi/agent/memory`, also reachable as `~/brain` and openable in Obsidian. The graph *is* the memory: notes are nodes, `[[wikilinks]]` are edges, daily notes are the sessions.

```
MEMORY.md      always injected, hard budget 4,000 chars / 150 lines  ← index only
index.md       hub MOC the graph is read from
maps/          MOCs: systems, projects
notes/         atomic durable facts
decisions/     choices with rejected options
lessons/       mistakes + the promotion that closed them
reviews/       weekly consolidation records
daily/         pi-memory's episodic log; a session that touches notes gets one auto link line
dash.base      live tables: lessons, notes by status, recent
```

`MEMORY.md` is **not** a dump. Anything past 4,000 chars is silently cut from every turn (`pi-memory` caps it). Detail goes in a note; `MEMORY.md` gets one line and a link.

## Recall

1. `memory_search` (keyword for names/dates, semantic for meaning) before assuming.
2. Open the note with `read` and follow its links — neighbours carry the context.
3. `memory-lint` when the vault itself feels wrong (dead links, orphans, budget).

## Write a fact

One idea per note, in `notes/`, filename = kebab-case claim (`pi-skill-precedence.md`, not `pi-notes.md`):

```markdown
---
type: note            # note | map | decision | lesson | review
status: active        # active | archive | superseded | pinned
tags: [area/topic]
created: 2026-01-01
updated: 2026-01-01
---
# Claim as a sentence

What is true, then the mechanism that makes it true.

> [!bug] The failure mode, when there is one.

## Links

[[MEMORY]] · [[related-note]] · [[maps/systems]]
```

Rules that keep the graph useful:

- Link **inline in prose** where the relation is explained; duplicated link lists rot.
- Every note is linked **from** a map or from `MEMORY.md`. No orphans.
- Bump `updated:` on every edit — `dash.base` and lint read it.
- `status: archive` for facts that are no longer true but worth the history (link them from a map's archive section).
- Never invent a fact to fill a template; an empty note is worse than no note.
- Obsidian syntax (callouts, embeds, properties, bases) — skill `obsidian-markdown` / `obsidian-bases`.

Promote a fact into `MEMORY.md` only when it must change behaviour **every turn**; otherwise it stays a note.

## Write a lesson (the RSI half)

A lesson exists to change procedure, not to be remembered.

```markdown
---
type: lesson
status: active
tags: [failure]
promoted: decisions/2026-01-01-some-decision   # required, or it is debt
---
# Short imperative title

**Trigger:** what situation.
**Wrong:** what was done.
**Right:** what to do instead.
**Promoted to:** the file that now enforces it (skill, AGENTS.md, lint rule).
```

The loop, in order:

1. **Capture** — the fact or failure happens.
2. **Consolidate** — new note, or edit the existing one instead of adding a near-duplicate.
3. **Promote** — change the skill / `AGENTS.md` / lint so the mistake cannot repeat; fill `promoted:`.
4. **Verify** — `memory-lint` passes; if it cannot, the "improvement" was decorative.

A lesson with no `promoted:` is lint debt. Say so instead of writing more notes.

## Consolidate (weekly)

Write `reviews/YYYY-Www.md`:

- merge duplicate notes, delete dead ones (and their `MEMORY.md` lines)
- demote stale `MEMORY.md` lines into notes; keep the index under ~3,600 chars
- promote every lesson this week earned
- keep the review's links — they connect that week's sessions to the graph

## Commands

- `memory-lint` — budget, dead links, orphans, unreachable notes, duplicate names, unpromoted lessons, stale notes
- `memory-lint --brief` — one line
- `/memory` — the same inside a Pi session

Lint errors outrank new notes: fix the vault before adding to it.
