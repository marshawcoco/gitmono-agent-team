export const AGENT_IDS = Object.freeze(["implementer", "verifier", "integrator"]);

export const ROLE_TASKS = Object.freeze({
  implementer: {
    role: "Patch Implementer",
    inputs: ["IntentSpec", "locked baseCommit", "allowedPaths", "acceptance criteria"],
    outputs: ["PatchSet reference", "changed paths", "self-test evidence", "Libra checkpoint"],
    normalHandoff: { to: "verifier", status: "ready" }
  },
  verifier: {
    role: "Independent Verifier",
    inputs: ["IntentSpec", "Implementer Handoff", "PatchSet reference", "locked baseCommit"],
    outputs: ["independent test evidence", "needs_changes or passed result"],
    normalHandoff: { to: "integrator", status: "passed" }
  },
  integrator: {
    role: "Integration Guardian",
    inputs: ["IntentSpec", "Implementer and Verifier Handoffs", "current target branch state"],
    outputs: ["gate evaluation", "review evidence", "approval or block decision"],
    normalHandoff: { to: "human", status: "approved" }
  }
});

const SHA_PATTERN = /^[a-f0-9]{7,64}$/;
const ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RISK_LEVELS = new Set(["low", "medium", "high"]);
const EVIDENCE_KINDS = new Set(["build", "test", "review", "security", "human_approval", "finding"]);
const EVIDENCE_RESULTS = new Set(["passed", "failed", "approved", "rejected", "not_run", "info"]);

const HANDOFF_ROUTES = Object.freeze({
  implementer: {
    ready: new Set(["verifier"]),
    blocked: new Set(["verifier"])
  },
  verifier: {
    needs_changes: new Set(["implementer"]),
    blocked: new Set(["implementer"]),
    passed: new Set(["integrator"])
  },
  integrator: {
    approved: new Set(["human", "orchestrator"]),
    blocked: new Set(["human", "orchestrator"])
  }
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasEvidence(handoff, kind, result) {
  return handoff.evidence?.some((item) => item.kind === kind && item.result === result) ?? false;
}

export function validateIntentSpec(intent) {
  const errors = [];

  if (!isObject(intent)) {
    return { valid: false, errors: ["IntentSpec must be an object."] };
  }
  if (intent.schemaVersion !== "1.0") errors.push("schemaVersion must be '1.0'.");
  if (!ID_PATTERN.test(intent.intentId ?? "")) errors.push("intentId must be a lowercase kebab-case identifier.");
  if (!hasNonBlankString(intent.title)) errors.push("title is required.");
  if (!hasNonBlankString(intent.goal)) errors.push("goal is required.");

  const target = intent.target;
  if (!isObject(target)) {
    errors.push("target is required.");
  } else {
    if (!hasNonBlankString(target.repository)) errors.push("target.repository is required.");
    if (!SHA_PATTERN.test(target.baseCommit ?? "")) errors.push("target.baseCommit must be a Git commit SHA.");
    if (!Array.isArray(target.allowedPaths) || target.allowedPaths.length === 0) {
      errors.push("target.allowedPaths must contain at least one relative path.");
    } else if (target.allowedPaths.some((path) => !hasNonBlankString(path) || path.startsWith("/") || path.includes(".."))) {
      errors.push("target.allowedPaths must contain safe relative paths.");
    }
  }

  if (!Array.isArray(intent.acceptanceCriteria) || intent.acceptanceCriteria.length === 0) {
    errors.push("acceptanceCriteria must contain at least one check.");
  }
  if (!isObject(intent.constraints) || !RISK_LEVELS.has(intent.constraints.risk)) {
    errors.push("constraints.risk must be low, medium, or high.");
  } else if (!Array.isArray(intent.constraints.prohibitedActions)) {
    errors.push("constraints.prohibitedActions must be an array.");
  }
  if (!Array.isArray(intent.taskDag) || intent.taskDag.length === 0) {
    errors.push("taskDag must contain at least one task.");
  } else {
    const taskIds = new Set();
    for (const task of intent.taskDag) {
      if (
        !isObject(task)
        || !ID_PATTERN.test(task.taskId ?? "")
        || !AGENT_IDS.includes(task.owner)
        || !Array.isArray(task.dependsOn)
        || !hasNonBlankString(task.outcome)
      ) {
        errors.push("Each taskDag entry needs a taskId, owner, dependency array, and outcome.");
        break;
      }
      if (taskIds.has(task.taskId)) errors.push("taskDag taskIds must be unique.");
      taskIds.add(task.taskId);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateHandoff(handoff) {
  const errors = [];

  if (!isObject(handoff)) {
    return { valid: false, errors: ["Handoff must be an object."] };
  }
  if (handoff.schemaVersion !== "1.0") errors.push("schemaVersion must be '1.0'.");
  if (!UUID_PATTERN.test(handoff.handoffId ?? "")) errors.push("handoffId must be a UUID.");
  if (!ID_PATTERN.test(handoff.intentId ?? "")) errors.push("intentId must be a lowercase kebab-case identifier.");
  if (!ID_PATTERN.test(handoff.taskId ?? "")) errors.push("taskId must be a lowercase kebab-case identifier.");
  if (!SHA_PATTERN.test(handoff.baseCommit ?? "")) errors.push("baseCommit must be a Git commit SHA.");
  if (!AGENT_IDS.includes(handoff.from)) errors.push("from must be an Agent Team role.");
  if (!hasNonBlankString(handoff.to)) errors.push("to is required.");
  if (!hasNonBlankString(handoff.summary) || handoff.summary.trim().length < 8) errors.push("summary must be at least 8 characters.");
  if (!hasNonBlankString(handoff.createdAt) || Number.isNaN(Date.parse(handoff.createdAt))) {
    errors.push("createdAt must be an ISO timestamp.");
  }

  const permittedRecipients = HANDOFF_ROUTES[handoff.from]?.[handoff.status];
  if (!permittedRecipients || !permittedRecipients.has(handoff.to)) {
    errors.push("from, status, and to do not form a permitted handoff route.");
  }
  if (!Array.isArray(handoff.evidence) || handoff.evidence.length === 0) {
    errors.push("evidence must contain at least one item.");
  } else {
    for (const item of handoff.evidence) {
      if (!isObject(item) || !EVIDENCE_KINDS.has(item.kind) || !EVIDENCE_RESULTS.has(item.result) || !hasNonBlankString(item.summary)) {
        errors.push("Each evidence item needs a known kind, result, and summary.");
        break;
      }
    }
  }
  if (handoff.changedPaths !== undefined && (!Array.isArray(handoff.changedPaths) || handoff.changedPaths.some((item) => !hasNonBlankString(item) || item.startsWith("/") || item.includes("..")))) {
    errors.push("changedPaths, when present, must contain safe relative paths.");
  }

  if (handoff.from === "implementer" && handoff.status === "ready" && !hasNonBlankString(handoff.patchRef)) {
    errors.push("Implementer ready handoffs require patchRef.");
  }
  if (handoff.from === "verifier" && handoff.status === "passed") {
    if (!hasNonBlankString(handoff.patchRef)) errors.push("Verifier passed handoffs require patchRef.");
    if (!hasEvidence(handoff, "test", "passed")) errors.push("Verifier passed handoffs require passed test evidence.");
  }
  if (handoff.from === "integrator" && handoff.status === "approved") {
    if (!hasNonBlankString(handoff.patchRef)) errors.push("Integrator approved handoffs require patchRef.");
    if (!hasEvidence(handoff, "review", "approved")) errors.push("Integrator approved handoffs require approved review evidence.");
  }

  return { valid: errors.length === 0, errors };
}

function latestByRoleAfter(handoffs, role, afterIndex = -1) {
  for (let index = handoffs.length - 1; index > afterIndex; index -= 1) {
    if (handoffs[index].from === role) return { handoff: handoffs[index], index };
  }
  return undefined;
}

export function deriveGate({ handoffs, intentId, risk = "medium", baseCommit } = {}) {
  if (!Array.isArray(handoffs)) throw new TypeError("handoffs must be an array.");
  if (!ID_PATTERN.test(intentId ?? "")) throw new TypeError("intentId must be a lowercase kebab-case identifier.");
  if (!RISK_LEVELS.has(risk)) throw new TypeError("risk must be low, medium, or high.");

  const chain = handoffs.filter((handoff) => handoff.intentId === intentId);
  // Each stage must have been appended after the stage it evaluates. A newer
  // implementation therefore invalidates verification and approval from an
  // earlier PatchSet, even when the intent and base commit are unchanged.
  const implementationEntry = latestByRoleAfter(chain, "implementer");
  const verificationEntry = implementationEntry
    ? latestByRoleAfter(chain, "verifier", implementationEntry.index)
    : undefined;
  const integrationEntry = verificationEntry
    ? latestByRoleAfter(chain, "integrator", verificationEntry.index)
    : undefined;
  const implementation = implementationEntry?.handoff;
  const verification = verificationEntry?.handoff;
  const integration = integrationEntry?.handoff;
  const expectedBase = baseCommit ?? implementation?.baseCommit;
  const relevantHandoffs = [implementation, verification, integration].filter(Boolean);

  const baseCommitConsistent = relevantHandoffs.length >= 2
    && expectedBase !== undefined
    && relevantHandoffs.every((handoff) => handoff.baseCommit === expectedBase);
  const implementerDelivered = implementation?.status === "ready" && hasNonBlankString(implementation.patchRef);
  const verificationPassed = verification?.status === "passed";
  const testEvidencePassed = verificationPassed && hasEvidence(verification, "test", "passed");
  const reviewApproved = integration?.status === "approved" && hasEvidence(integration, "review", "approved");
  const patchRefConsistent = relevantHandoffs.length === 3
    && hasNonBlankString(implementation?.patchRef)
    && relevantHandoffs.every((handoff) => handoff.patchRef === implementation.patchRef);
  const humanApproval = risk !== "high" || (integration?.status === "approved" && hasEvidence(integration, "human_approval", "approved"));
  const readyToMerge = Boolean(
    implementerDelivered
      && verificationPassed
      && testEvidencePassed
      && reviewApproved
      && patchRefConsistent
      && baseCommitConsistent
      && humanApproval
  );

  return {
    intentId,
    risk,
    handoffCount: chain.length,
    expectedBaseCommit: expectedBase ?? null,
    implementerDelivered,
    verificationPassed,
    testEvidencePassed,
    reviewApproved,
    patchRefConsistent,
    baseCommitConsistent,
    humanApproval,
    readyToMerge
  };
}
