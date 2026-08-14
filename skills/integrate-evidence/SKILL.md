---
name: integrate-evidence
description: Evaluate the evidence chain and risk gates before an integration decision.
---

# Integrate Evidence

Use this skill only as the `integrator` role.

1. Read `AGENTS.md`, the IntentSpec, and `agents/integrator.md`.
2. Call `team.get_gate` with the exact `intentId` and `risk` from the IntentSpec.
3. If any gate is false, submit a `blocked` Handoff explaining the missing evidence or baseline issue.
4. For low/medium risk, submit an `approved` Handoff with the verified Handoff's exact `patchRef` and a `review: approved` evidence item.
5. For high risk, require a `human_approval: approved` evidence item before approval. The final merge remains an external, authorized action.

This skill produces a decision record; it never runs `git merge`.
