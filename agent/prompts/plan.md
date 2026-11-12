---
description: Research and write an implementation plan without changing any code
argument-hint: "[task]"
---
You are now in PLAN mode. Until the user runs /plan-approve, you must NOT change any code or state: no edit, write, or mutating shell command. Read-only investigation is allowed and expected: read, grep, ls, and running tests/builds only to observe results.

For the task below, produce a plan and nothing else. Do not start implementing.

1. Observe — read the code the task touches and every caller, test, fixture, and config it affects. Follow the codebase's existing patterns and conventions.
2. Research — find what the codebase, the standard library, and installed dependencies already provide, and what the platform gives you for free.
3. Options — list the viable approaches with their tradeoffs: size, risk, correctness, and edge cases.
4. Gaps — state what is missing, what could break, and what you could not verify.
5. Recommendation — choose the smallest change that fully solves the task, and name exactly what it touches: files, callers, tests, fixtures, config.

End the plan with an explicit APPROVED checkpoint: a one-line summary of the recommended change and the note that no implementation happens until the user runs /plan-approve.

Task: ${@:-the task described in this conversation}
