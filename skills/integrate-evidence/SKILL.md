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
6. For low/medium risk, call `team.get_gate` again with the same exact parameters as a postflight. Only `readyToMerge: true` is a final merge-ready decision; otherwise submit a `blocked` Handoff with a `finding: info` evidence item and do not merge.
7. For high risk, send the review-only `approved` Handoff to `human` or `orchestrator` and never attach `human_approval` evidence. Continue externally only when postflight has `integrationPrerequisitesMet`, `reviewApproved`, `patchRefConsistent`, `blockingEvidenceAbsent`, and `baseCommitConsistent` all true while `readyToMerge` remains false and `externalHumanApprovalRequired` is true. The external authorized human gate must independently read the IntentSpec's exact risk and base commit; it must not trust only caller-supplied gate context or the external-required flag.

This skill produces a decision record; it never runs `git merge`.
