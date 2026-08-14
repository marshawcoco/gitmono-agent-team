---
name: verify-patch
description: Independently verify a PatchSet against an IntentSpec and return evidence-backed results.
---

# Verify Patch

Use this skill only as the `verifier` role.

1. Read `AGENTS.md`, the IntentSpec, and `agents/verifier.md`.
2. Call `team.list_handoffs` and find the Implementer Handoff for the same `intentId` and `baseCommit`.
3. Independently apply or check out its `patchRef`; run the specified acceptance and regression tests.
4. If evidence or tests fail, submit `needs_changes` to `implementer` with an actionable failing-test evidence item.
5. If they pass, submit `passed` to `integrator` with the Implementer Handoff's exact `patchRef` and at least one `test` evidence item whose `result` is `passed`.

Do not edit the PatchSet under verification.
