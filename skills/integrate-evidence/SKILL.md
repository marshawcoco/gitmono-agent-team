---
name: integrate-evidence
description: Evaluate the evidence chain and risk gates before an integration decision.
---

# Integrate Evidence

Use this skill only as the `integrator` role.

1. Read `AGENTS.md`, the IntentSpec, and `agents/integrator.md`.
2. Before reviewing, call `team.get_gate` with the exact `intentId`, `risk`, and `baseCommit` from the IntentSpec.
3. Treat this first response as a preflight. Continue only when `integrationPrerequisitesMet` is true; it requires Implementer delivery, Verifier passed test evidence, an exact shared `patchRef`, no blocking evidence, and an exact IntentSpec `baseCommit`. `reviewApproved: false` and `readyToMerge: false` are expected before the Integrator has submitted a decision; they are not approval to merge and are not, by themselves, reasons to block. If a prerequisite is false, submit a `blocked` Handoff with a `finding: info` evidence item explaining the missing evidence or baseline issue.
4. Independently inspect `allowedPaths`, conflicts, the evidence chain, and risk changes.
5. Every `approved` Handoff must copy the verified Handoff's exact `patchRef` and include a `review: approved` evidence item.
6. For high risk, that same `approved` Handoff must also include independently obtained `human_approval: approved` evidence. If it is absent, submit `blocked` with a `finding: info` evidence item identifying the missing human approval; never create approval evidence yourself.
7. After submitting an approval, call `team.get_gate` again with the same exact parameters as a postflight. Only `readyToMerge: true` is a final merge-ready decision. If it remains false, submit a `blocked` Handoff with a `finding: info` evidence item explaining the failed postflight and do not merge.

This skill produces a decision record; it never runs `git merge`.
