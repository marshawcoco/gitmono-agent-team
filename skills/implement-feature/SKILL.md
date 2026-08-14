---
name: implement-feature
description: Implement one bounded IntentSpec task and hand its PatchSet to the independent verifier.
---

# Implement Feature

Use this skill only as the `implementer` role.

1. Read `AGENTS.md`, the IntentSpec, and `agents/implementer.md`.
2. Call `team.get_task` with `agentId: "implementer"`; validate that HEAD is the declared `baseCommit`.
3. Work only inside `constraints.allowedPaths`; record unexpected scope as a blocker.
4. Run the acceptance checks and build a `ready` Handoff with `patchRef`, `changedPaths`, test evidence, and Libra checkpoint identifiers when available.
5. Call `team.submit_handoff`. The only normal recipient is `verifier`.

Never attempt a merge or bypass failed tests.
