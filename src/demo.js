import { createDispatcher } from "./mcp-server.js";

const dispatcher = createDispatcher();
const intentId = "demo-session-timeout";
const baseCommit = "a5bf591";

await dispatcher.call("team.submit_handoff", {
  intentId,
  taskId: "implement-session-timeout",
  baseCommit,
  from: "implementer",
  to: "verifier",
  status: "ready",
  patchRef: "refs/heads/agent/session-timeout",
  changedPaths: ["src/auth/session.ts", "test/auth/session.test.ts"],
  summary: "Implemented inactivity timeout with focused unit coverage.",
  evidence: [{ kind: "test", result: "passed", command: "npm test -- session-timeout", summary: "12 focused tests passed" }]
});

await dispatcher.call("team.submit_handoff", {
  intentId,
  taskId: "verify-session-timeout",
  baseCommit,
  from: "verifier",
  to: "integrator",
  status: "passed",
  patchRef: "refs/heads/agent/session-timeout",
  summary: "Acceptance and regression checks passed independently.",
  evidence: [{ kind: "test", result: "passed", command: "npm test -- session-timeout", summary: "18 tests passed" }]
});

await dispatcher.call("team.submit_handoff", {
  intentId,
  taskId: "integrate-session-timeout",
  baseCommit,
  from: "integrator",
  to: "human",
  status: "approved",
  summary: "Evidence chain is complete for the medium-risk change.",
  evidence: [{ kind: "review", result: "approved", summary: "No path, baseline, or evidence conflict found" }]
});

const gate = await dispatcher.call("team.get_gate", { intentId, risk: "medium", baseCommit });
console.log(JSON.stringify(gate, null, 2));
