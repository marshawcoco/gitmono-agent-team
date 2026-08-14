import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createDispatcher, handleRequest } from "../src/mcp-server.js";
import { deriveGate, validateHandoff, validateIntentSpec } from "../src/protocol.js";

const intentPath = new URL("../examples/intent-spec.example.json", import.meta.url);
const serverPath = fileURLToPath(new URL("../src/mcp-server.js", import.meta.url));
const intent = JSON.parse(await readFile(intentPath, "utf8"));

function runMcpServer(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`MCP server exited with ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
    });
    child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  });
}

function handoff(overrides = {}) {
  return {
    schemaVersion: "1.0",
    handoffId: "5f8d5d6d-91bb-4a90-b391-274ff64ee6ee",
    intentId: "add-session-timeout",
    taskId: "implement-session-timeout",
    baseCommit: "a5bf591",
    from: "implementer",
    to: "verifier",
    status: "ready",
    patchRef: "refs/heads/agent/session-timeout",
    summary: "Implemented session timeout with focused coverage.",
    evidence: [{ kind: "test", result: "passed", summary: "12 tests passed" }],
    createdAt: "2026-08-14T04:00:00.000Z",
    ...overrides
  };
}

test("the example IntentSpec is valid", () => {
  assert.deepEqual(validateIntentSpec(intent), { valid: true, errors: [] });
});

test("a verifier cannot pass without passed test evidence", () => {
  const invalid = handoff({
    from: "verifier",
    to: "integrator",
    status: "passed",
    evidence: [{ kind: "test", result: "failed", summary: "timeout test failed" }]
  });
  assert.equal(validateHandoff(invalid).valid, false);
});

test("positive verifier and integrator handoffs require patchRef", () => {
  const verifier = handoff({
    from: "verifier",
    to: "integrator",
    status: "passed",
    patchRef: undefined,
    evidence: [{ kind: "test", result: "passed", summary: "tests passed" }]
  });
  const integrator = handoff({
    from: "integrator",
    to: "human",
    status: "approved",
    patchRef: undefined,
    evidence: [{ kind: "review", result: "approved", summary: "review passed" }]
  });

  assert.equal(validateHandoff(verifier).valid, false);
  assert.equal(validateHandoff(integrator).valid, false);
});

test("positive handoffs reject failed or rejected evidence", () => {
  const positiveHandoffs = [
    handoff({
      evidence: [
        { kind: "test", result: "passed", summary: "self-tests passed" },
        { kind: "security", result: "failed", summary: "security scan failed" }
      ]
    }),
    handoff({
      from: "verifier",
      to: "integrator",
      status: "passed",
      evidence: [
        { kind: "test", result: "passed", summary: "acceptance tests passed" },
        { kind: "test", result: "failed", summary: "regression test failed" }
      ]
    }),
    handoff({
      from: "integrator",
      to: "human",
      status: "approved",
      evidence: [
        { kind: "review", result: "approved", summary: "review approved" },
        { kind: "review", result: "rejected", summary: "security review rejected" }
      ]
    })
  ];

  for (const positiveHandoff of positiveHandoffs) {
    assert.equal(validateHandoff(positiveHandoff).valid, false);
  }
});

test("negative handoffs retain their failure evidence", () => {
  const negativeHandoffs = [
    handoff({
      status: "blocked",
      evidence: [{ kind: "build", result: "failed", summary: "build failed" }]
    }),
    handoff({
      from: "verifier",
      to: "implementer",
      status: "needs_changes",
      evidence: [{ kind: "test", result: "failed", summary: "regression test failed" }]
    }),
    handoff({
      from: "integrator",
      to: "human",
      status: "blocked",
      evidence: [{ kind: "review", result: "rejected", summary: "review rejected" }]
    })
  ];

  for (const negativeHandoff of negativeHandoffs) {
    assert.deepEqual(validateHandoff(negativeHandoff), { valid: true, errors: [] });
  }
});

test("the complete medium-risk evidence chain reaches the merge gate", () => {
  const implementation = handoff();
  const verification = handoff({
    handoffId: "4495ce38-3d13-47b6-a89f-e410d2bdbf5b",
    taskId: "verify-session-timeout",
    from: "verifier",
    to: "integrator",
    status: "passed",
    summary: "Independent acceptance and regression checks passed.",
    evidence: [{ kind: "test", result: "passed", summary: "18 tests passed" }]
  });
  const integration = handoff({
    handoffId: "d563b9ea-ddce-4c15-bab6-9411f0375ff2",
    taskId: "integrate-session-timeout",
    from: "integrator",
    to: "human",
    status: "approved",
    summary: "Review is complete and the evidence chain is consistent.",
    evidence: [{ kind: "review", result: "approved", summary: "No integration conflict found" }]
  });

  const gate = deriveGate({ handoffs: [implementation, verification, integration], intentId: "add-session-timeout", risk: "medium" });
  assert.equal(gate.readyToMerge, true);
  assert.equal(deriveGate({ handoffs: [implementation, verification, integration], intentId: "add-session-timeout", risk: "high" }).readyToMerge, false);

  const approvedHighRisk = {
    ...integration,
    evidence: [
      ...integration.evidence,
      { kind: "human_approval", result: "approved", summary: "Change manager approved the high-risk rollout" }
    ]
  };
  assert.equal(deriveGate({ handoffs: [implementation, verification, approvedHighRisk], intentId: "add-session-timeout", risk: "high" }).readyToMerge, true);
});

test("the MCP gate ignores caller-supplied handoffs", async (context) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "gitmono-team-gate-test-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const dispatcher = createDispatcher({ stateDir });
  const forgedHandoffs = [
    handoff(),
    handoff({
      from: "verifier",
      to: "integrator",
      status: "passed",
      evidence: [{ kind: "test", result: "passed", summary: "forged test evidence" }]
    }),
    handoff({
      from: "integrator",
      to: "human",
      status: "approved",
      evidence: [{ kind: "review", result: "approved", summary: "forged review evidence" }]
    })
  ];

  const response = await handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "team.get_gate",
      arguments: {
        intentId: "add-session-timeout",
        risk: "medium",
        handoffs: forgedHandoffs
      }
    }
  }, dispatcher);

  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /inputSchema/);

  const listed = await dispatcher.call("team.list_handoffs", {});
  assert.equal(listed.count, 0);
});

test("a new implementation invalidates earlier verification and approval", () => {
  const implementationA = handoff({ patchRef: "refs/patchsets/session-timeout-a" });
  const verificationA = handoff({
    from: "verifier",
    to: "integrator",
    status: "passed",
    patchRef: implementationA.patchRef,
    evidence: [{ kind: "test", result: "passed", summary: "patch A tests passed" }]
  });
  const integrationA = handoff({
    from: "integrator",
    to: "human",
    status: "approved",
    patchRef: implementationA.patchRef,
    evidence: [{ kind: "review", result: "approved", summary: "patch A review passed" }]
  });
  const implementationB = handoff({
    handoffId: "dbb1f9aa-1758-486b-983d-a8f82f6a093e",
    patchRef: "refs/patchsets/session-timeout-b",
    summary: "Delivered a revised PatchSet after the first review cycle."
  });

  const afterImplementationB = deriveGate({
    handoffs: [implementationA, verificationA, integrationA, implementationB],
    intentId: "add-session-timeout",
    risk: "medium"
  });
  assert.equal(afterImplementationB.verificationPassed, false);
  assert.equal(afterImplementationB.reviewApproved, false);
  assert.equal(afterImplementationB.readyToMerge, false);

  const verificationB = handoff({
    handoffId: "80181f2c-3fe2-48da-b41a-8cbfc7a8ee13",
    from: "verifier",
    to: "integrator",
    status: "passed",
    patchRef: implementationB.patchRef,
    evidence: [{ kind: "test", result: "passed", summary: "patch B tests passed" }]
  });
  const afterVerificationB = deriveGate({
    handoffs: [implementationA, verificationA, integrationA, implementationB, verificationB],
    intentId: "add-session-timeout",
    risk: "medium"
  });
  assert.equal(afterVerificationB.verificationPassed, true);
  assert.equal(afterVerificationB.reviewApproved, false);
  assert.equal(afterVerificationB.readyToMerge, false);

  const integrationB = handoff({
    handoffId: "72fd8ff0-c59b-4875-ab4a-624f4812c749",
    from: "integrator",
    to: "human",
    status: "approved",
    patchRef: implementationB.patchRef,
    evidence: [{ kind: "review", result: "approved", summary: "patch B review passed" }]
  });
  const completePatchB = deriveGate({
    handoffs: [implementationA, verificationA, integrationA, implementationB, verificationB, integrationB],
    intentId: "add-session-timeout",
    risk: "medium"
  });
  assert.equal(completePatchB.patchRefConsistent, true);
  assert.equal(completePatchB.readyToMerge, true);

  const mismatchedChains = [
    [implementationB, { ...verificationB, patchRef: implementationA.patchRef }, integrationB],
    [implementationB, verificationB, { ...integrationB, patchRef: implementationA.patchRef }],
    [implementationB, verificationB, { ...integrationB, patchRef: undefined }]
  ];
  for (const chain of mismatchedChains) {
    const gate = deriveGate({ handoffs: chain, intentId: "add-session-timeout", risk: "medium" });
    assert.equal(gate.patchRefConsistent, false);
    assert.equal(gate.readyToMerge, false);
  }
});

test("blocking evidence cannot be hidden beside positive evidence", () => {
  const implementation = handoff();
  const verification = handoff({
    handoffId: "4495ce38-3d13-47b6-a89f-e410d2bdbf5b",
    taskId: "verify-session-timeout",
    from: "verifier",
    to: "integrator",
    status: "passed",
    evidence: [
      { kind: "test", result: "passed", summary: "acceptance tests passed" },
      { kind: "test", result: "failed", summary: "regression test failed" }
    ]
  });
  const integration = handoff({
    handoffId: "d563b9ea-ddce-4c15-bab6-9411f0375ff2",
    taskId: "integrate-session-timeout",
    from: "integrator",
    to: "human",
    status: "approved",
    evidence: [{ kind: "review", result: "approved", summary: "review approved" }]
  });

  const failedImplementation = {
    ...implementation,
    evidence: [
      ...implementation.evidence,
      { kind: "security", result: "failed", summary: "security scan failed" }
    ]
  };
  const cleanVerificationForImplementation = {
    ...verification,
    evidence: [{ kind: "test", result: "passed", summary: "all tests passed" }]
  };
  const failedImplementationGate = deriveGate({
    handoffs: [failedImplementation, cleanVerificationForImplementation, integration],
    intentId: "add-session-timeout",
    risk: "medium"
  });
  assert.equal(failedImplementationGate.blockingEvidenceAbsent, false);
  assert.equal(failedImplementationGate.readyToMerge, false);

  const failedTestGate = deriveGate({
    handoffs: [implementation, verification, integration],
    intentId: "add-session-timeout",
    risk: "medium"
  });
  assert.equal(failedTestGate.testEvidencePassed, false);
  assert.equal(failedTestGate.blockingEvidenceAbsent, false);
  assert.equal(failedTestGate.readyToMerge, false);

  const securityFailedVerification = {
    ...verification,
    evidence: [
      { kind: "test", result: "passed", summary: "all tests passed" },
      { kind: "security", result: "failed", summary: "security scan failed" }
    ]
  };
  const securityVetoGate = deriveGate({
    handoffs: [implementation, securityFailedVerification, integration],
    intentId: "add-session-timeout",
    risk: "medium"
  });
  assert.equal(securityVetoGate.testEvidencePassed, true);
  assert.equal(securityVetoGate.blockingEvidenceAbsent, false);
  assert.equal(securityVetoGate.readyToMerge, false);

  const cleanVerification = {
    ...verification,
    evidence: [{ kind: "test", result: "passed", summary: "all tests passed" }]
  };
  const rejectedReview = {
    ...integration,
    evidence: [
      { kind: "review", result: "approved", summary: "review approved" },
      { kind: "review", result: "rejected", summary: "security review rejected" }
    ]
  };
  const rejectedReviewGate = deriveGate({
    handoffs: [implementation, cleanVerification, rejectedReview],
    intentId: "add-session-timeout",
    risk: "medium"
  });
  assert.equal(rejectedReviewGate.reviewApproved, false);
  assert.equal(rejectedReviewGate.blockingEvidenceAbsent, false);
  assert.equal(rejectedReviewGate.readyToMerge, false);

  const disputedHumanApproval = {
    ...integration,
    evidence: [
      { kind: "review", result: "approved", summary: "review approved" },
      { kind: "human_approval", result: "approved", summary: "change manager approved" },
      { kind: "human_approval", result: "rejected", summary: "security owner rejected" }
    ]
  };
  const disputedApprovalGate = deriveGate({
    handoffs: [implementation, cleanVerification, disputedHumanApproval],
    intentId: "add-session-timeout",
    risk: "high"
  });
  assert.equal(disputedApprovalGate.humanApproval, false);
  assert.equal(disputedApprovalGate.blockingEvidenceAbsent, false);
  assert.equal(disputedApprovalGate.readyToMerge, false);

  const explicitHumanRejection = {
    ...integration,
    evidence: [
      { kind: "review", result: "approved", summary: "review approved" },
      { kind: "human_approval", result: "rejected", summary: "change manager rejected" }
    ]
  };
  const mediumRiskVetoGate = deriveGate({
    handoffs: [implementation, cleanVerification, explicitHumanRejection],
    intentId: "add-session-timeout",
    risk: "medium"
  });
  assert.equal(mediumRiskVetoGate.humanApproval, true);
  assert.equal(mediumRiskVetoGate.blockingEvidenceAbsent, false);
  assert.equal(mediumRiskVetoGate.readyToMerge, false);
});

test("the MCP dispatcher persists a handoff and exposes tools", async (context) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "gitmono-team-test-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const dispatcher = createDispatcher({ stateDir });

  const taskResponse = await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "team.get_task", arguments: { agentId: "verifier" } }
  }, dispatcher);
  assert.equal(taskResponse.result.structuredContent.role, "Independent Verifier");

  const saved = await dispatcher.call("team.submit_handoff", handoff({ handoffId: undefined, createdAt: undefined }));
  assert.equal(saved.accepted, true);
  const listed = await dispatcher.call("team.list_handoffs", { intentId: "add-session-timeout" });
  assert.equal(listed.count, 1);
  assert.equal(listed.handoffs[0].handoffId.length > 0, true);
});

test("JSON-RPC notifications never produce responses", async (context) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "gitmono-team-notification-test-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const dispatcher = createDispatcher({ stateDir });
  const notifications = [
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "tools/list" },
    { jsonrpc: "2.0", method: "tools/call", params: { name: "unknown.tool", arguments: {} } },
    {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "notification-test", version: "1.0.0" }
      }
    },
    {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: null,
        capabilities: {},
        clientInfo: { name: "notification-test", version: "1.0.0" }
      }
    },
    { jsonrpc: "2.0", method: "initialize" }
  ];

  for (const notification of notifications) {
    assert.equal(await handleRequest(notification, dispatcher), undefined);
  }

  const invalidRequest = await handleRequest({ jsonrpc: "2.0", method: 42 }, dispatcher);
  assert.equal(invalidRequest.id, null);
  assert.equal(invalidRequest.error.code, -32600);

  const nullIdRequest = await handleRequest({ jsonrpc: "2.0", id: null, method: "tools/list" }, dispatcher);
  assert.equal(nullIdRequest.id, null);
  assert.ok(Array.isArray(nullIdRequest.result.tools));

  const nullIdNotificationMethod = await handleRequest({
    jsonrpc: "2.0",
    id: null,
    method: "notifications/initialized"
  }, dispatcher);
  assert.equal(nullIdNotificationMethod.id, null);
  assert.equal(nullIdNotificationMethod.error.code, -32600);

  const nullIdInitialize = await handleRequest({
    jsonrpc: "2.0",
    id: null,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "request-test", version: "1.0.0" }
    }
  }, dispatcher);
  assert.equal(nullIdInitialize.id, null);
  assert.equal(nullIdInitialize.result.protocolVersion, "2025-11-25");

  const nullIdInvalidInitialize = await handleRequest({
    jsonrpc: "2.0",
    id: null,
    method: "initialize",
    params: { protocolVersion: null }
  }, dispatcher);
  assert.equal(nullIdInvalidInitialize.id, null);
  assert.equal(nullIdInvalidInitialize.error.code, -32602);

  const wireResponses = await runMcpServer([
    ...notifications,
    { jsonrpc: "2.0", id: 7, method: "tools/list" }
  ]);
  assert.equal(wireResponses.length, 1);
  assert.equal(wireResponses[0].id, 7);
  assert.ok(Array.isArray(wireResponses[0].result.tools));
});

test("initialize negotiates only the supported legacy MCP version", async () => {
  const dispatcher = createDispatcher();
  const initialize = (id, protocolVersion) => handleRequest({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "protocol-test", version: "1.0.0" }
    }
  }, dispatcher);

  for (const requestedVersion of ["2025-11-25", "2026-07-28", "2099-01-01"]) {
    const response = await initialize(requestedVersion, requestedVersion);
    assert.equal(response.id, requestedVersion);
    assert.equal(response.result.protocolVersion, "2025-11-25");
  }

  for (const invalidVersion of [undefined, null, 20251125, " "]) {
    const response = await initialize("invalid-version", invalidVersion);
    assert.equal(response.error.code, -32602);
    assert.deepEqual(response.error.data.supported, ["2025-11-25"]);
  }

  const discovery = await handleRequest({
    jsonrpc: "2.0",
    id: "discover",
    method: "server/discover",
    params: {}
  }, dispatcher);
  assert.equal(discovery.error.code, -32601);
});

test("the dispatcher enforces every advertised tool inputSchema", async (context) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "gitmono-team-schema-test-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const dispatcher = createDispatcher({ stateDir });

  const invalidCalls = [
    ["team.get_task", { agentId: "verifier", unexpected: true }],
    ["team.get_task", {}],
    ["team.list_handoffs", "wrong"],
    ["team.list_handoffs", null],
    ["team.list_handoffs", []],
    ["team.list_handoffs", 42],
    ["team.list_handoffs", true],
    ["team.list_handoffs", { intentId: "add-session-timeout", extra: true }],
    ["team.get_gate", { intentId: "add-session-timeout", risk: "critical" }],
    ["team.get_gate", { intentId: "add-session-timeout", handoffs: [] }],
    ["team.submit_handoff", {
      ...handoff({ handoffId: undefined, createdAt: undefined }),
      unexpected: "must not be persisted"
    }],
    ["team.submit_handoff", handoff({
      handoffId: undefined,
      createdAt: undefined,
      evidence: [{
        kind: "test",
        result: "passed",
        summary: "tests passed",
        unexpected: "must not be persisted"
      }]
    })]
  ];

  for (const [name, args] of invalidCalls) {
    await assert.rejects(
      dispatcher.call(name, args),
      (error) => error.message === "Tool arguments failed inputSchema validation."
        && Array.isArray(error.details)
        && error.details.length > 0
    );
  }

  const sensitiveKey = "secret_api_key_must_not_be_reflected";
  await assert.rejects(
    dispatcher.call("team.get_task", {
      agentId: "verifier",
      [sensitiveKey]: "sensitive-value",
      ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`extra_${index}`, true]))
    }),
    (error) => error.details.length <= 8
      && !error.details.join("\n").includes(sensitiveKey)
      && !error.details.join("\n").includes("sensitive-value")
  );

  const listed = await dispatcher.call("team.list_handoffs", {});
  assert.equal(listed.count, 0);

  for (const invalidArguments of ["wrong", null]) {
    const response = await handleRequest({
      jsonrpc: "2.0",
      id: "invalid-input",
      method: "tools/call",
      params: { name: "team.list_handoffs", arguments: invalidArguments }
    }, dispatcher);
    assert.equal(response.result.isError, true);
    assert.match(response.result.structuredContent.error, /inputSchema/);
  }
});
