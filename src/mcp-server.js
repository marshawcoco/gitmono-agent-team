import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import path from "node:path";
import { AGENT_IDS, ROLE_TASKS, deriveGate, validateHandoff } from "./protocol.js";

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze(["2025-11-25"]);
const DEFAULT_MCP_PROTOCOL_VERSION = SUPPORTED_MCP_PROTOCOL_VERSIONS.at(-1);

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "team.get_task",
    description: "Return the responsibility, inputs, outputs, and normal handoff for one Agent Team role.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agentId"],
      properties: { agentId: { type: "string", enum: AGENT_IDS } }
    }
  },
  {
    name: "team.submit_handoff",
    description: "Validate and persist an evidence-backed role handoff. The server supplies handoffId and createdAt when omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["intentId", "taskId", "baseCommit", "from", "to", "status", "summary", "evidence"],
      properties: {
        schemaVersion: { type: "string", const: "1.0" },
        handoffId: { type: "string" },
        intentId: { type: "string", pattern: "^[a-z][a-z0-9-]{2,63}$" },
        taskId: { type: "string", pattern: "^[a-z][a-z0-9-]{2,63}$" },
        baseCommit: { type: "string", pattern: "^[a-f0-9]{7,64}$" },
        from: { type: "string", enum: AGENT_IDS },
        to: { type: "string", enum: ["implementer", "verifier", "integrator", "human", "orchestrator"] },
        status: { type: "string", enum: ["ready", "passed", "needs_changes", "approved", "blocked"] },
        patchRef: { type: "string", minLength: 1, pattern: "\\S" },
        changedPaths: { type: "array", items: { type: "string" } },
        summary: { type: "string", minLength: 8 },
        evidence: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "result", "summary"],
            properties: {
              kind: { type: "string", enum: ["build", "test", "review", "security", "finding"] },
              result: { type: "string", enum: ["passed", "failed", "approved", "rejected", "not_run", "info"] },
              summary: { type: "string", minLength: 3 },
              command: { type: "string" },
              ref: { type: "string" }
            }
          }
        },
        libra: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", minLength: 1 },
            checkpointId: { type: "string", minLength: 1 }
          }
        },
        createdAt: { type: "string" }
      },
      allOf: [{
        if: {
          anyOf: [
            { properties: { from: { const: "implementer" }, status: { const: "ready" } }, required: ["from", "status"] },
            { properties: { from: { const: "verifier" }, status: { const: "passed" } }, required: ["from", "status"] },
            { properties: { from: { const: "integrator" }, status: { const: "approved" } }, required: ["from", "status"] }
          ]
        },
        then: {
          properties: { patchRef: { type: "string", minLength: 1, pattern: "\\S" } },
          required: ["patchRef"]
        }
      }, {
        if: {
          properties: { status: { enum: ["ready", "passed", "approved"] } },
          required: ["status"]
        },
        then: {
          properties: {
            evidence: {
              type: "array",
              not: {
                contains: {
                  type: "object",
                  properties: { result: { enum: ["failed", "rejected"] } },
                  required: ["result"]
                }
              }
            }
          }
        }
      }]
    }
  },
  {
    name: "team.list_handoffs",
    description: "List persisted handoffs, optionally limited to an IntentSpec.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { intentId: { type: "string", pattern: "^[a-z][a-z0-9-]{2,63}$" } }
    }
  },
  {
    name: "team.get_gate",
    description: "Evaluate the evidence and risk gates required before a merge may be considered.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["intentId"],
      properties: {
        intentId: { type: "string", pattern: "^[a-z][a-z0-9-]{2,63}$" },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        baseCommit: { type: "string", pattern: "^[a-f0-9]{7,64}$" }
      }
    }
  }
]);
const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));

const schemaValidator = new Ajv2020({ allErrors: true, strict: true });
const TOOL_INPUT_VALIDATORS = new Map(
  TOOL_DEFINITIONS.map((tool) => [tool.name, schemaValidator.compile(tool.inputSchema)])
);
const MAX_INPUT_VALIDATION_DETAILS = 8;

function protocolError(message, details = []) {
  const error = new Error(message);
  error.details = details;
  return error;
}

function validateToolArguments(name, args) {
  const validate = TOOL_INPUT_VALIDATORS.get(name);
  if (!validate || validate(args)) return;
  const validationErrors = validate.errors ?? [];
  const hasOmittedErrors = validationErrors.length > MAX_INPUT_VALIDATION_DETAILS;
  const visibleErrorLimit = hasOmittedErrors
    ? MAX_INPUT_VALIDATION_DETAILS - 1
    : MAX_INPUT_VALIDATION_DETAILS;
  const details = validationErrors.slice(0, visibleErrorLimit).map((error) => {
    const pathLabel = error.instancePath || "/";
    return `${pathLabel} [${error.keyword}] ${error.message}`;
  });
  if (hasOmittedErrors) details.push("Additional validation errors omitted.");
  throw protocolError("Tool arguments failed inputSchema validation.", details);
}

async function readHandoffs(handoffFile) {
  try {
    const content = await readFile(handoffFile, "utf8");
    return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw protocolError(`Invalid JSON in handoff log at line ${index + 1}.`);
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function createDispatcher({ stateDir = process.env.AGENT_TEAM_STATE_DIR ?? path.join(process.cwd(), ".agent-team") } = {}) {
  const handoffFile = path.join(stateDir, "handoffs.jsonl");

  return {
    handoffFile,
    async call(name, args = {}) {
      validateToolArguments(name, args);
      switch (name) {
        case "team.get_task": {
          if (!AGENT_IDS.includes(args.agentId)) throw protocolError("agentId must identify one of the three Agent Team roles.");
          return { agentId: args.agentId, ...ROLE_TASKS[args.agentId] };
        }
        case "team.list_handoffs": {
          const handoffs = await readHandoffs(handoffFile);
          const filtered = args.intentId ? handoffs.filter((handoff) => handoff.intentId === args.intentId) : handoffs;
          return { handoffs: filtered, count: filtered.length };
        }
        case "team.submit_handoff": {
          const handoff = {
            schemaVersion: "1.0",
            ...args,
            handoffId: args.handoffId ?? randomUUID(),
            createdAt: args.createdAt ?? new Date().toISOString()
          };
          const validation = validateHandoff(handoff);
          if (!validation.valid) throw protocolError("Handoff failed protocol validation.", validation.errors);
          await mkdir(stateDir, { recursive: true });
          await appendFile(handoffFile, `${JSON.stringify(handoff)}\n`, "utf8");
          return { accepted: true, handoff };
        }
        case "team.get_gate": {
          const handoffs = await readHandoffs(handoffFile);
          const { intentId, risk, baseCommit } = args ?? {};
          return deriveGate({ handoffs, intentId, risk, baseCommit });
        }
        default:
          throw protocolError(`Unknown MCP tool: ${name}`);
      }
    }
  };
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError
  };
}

function requestResponse(request, payload) {
  if (!Object.prototype.hasOwnProperty.call(request, "id")) return undefined;
  return { jsonrpc: "2.0", id: request.id, ...payload };
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidParams(request, message) {
  return requestResponse(request, { error: { code: -32602, message } });
}

function validateCallToolParams(params) {
  if (!isJsonObject(params)) return "tools/call params must be an object.";
  if (typeof params.name !== "string") return "tools/call params.name must be a string.";
  if (Object.prototype.hasOwnProperty.call(params, "arguments") && !isJsonObject(params.arguments)) {
    return "tools/call params.arguments must be an object when present.";
  }
  if (Object.prototype.hasOwnProperty.call(params, "_meta") && !isJsonObject(params._meta)) {
    return "tools/call params._meta must be an object when present.";
  }
  if (Object.prototype.hasOwnProperty.call(params, "task") && !isJsonObject(params.task)) {
    return "tools/call params.task must be an object when present.";
  }
  if (Object.prototype.hasOwnProperty.call(params, "task")) {
    return "Task-augmented tool calls are not supported.";
  }
  return undefined;
}

export async function handleRequest(request, dispatcher) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request." } };
  }
  if (request.method === "notifications/initialized") {
    return requestResponse(request, {
      error: { code: -32600, message: "Notification methods must omit id." }
    });
  }

  if (request.method === "initialize") {
    const requestedVersion = request.params?.protocolVersion;
    if (typeof requestedVersion !== "string" || requestedVersion.trim().length === 0) {
      return requestResponse(request, {
        error: {
          code: -32602,
          message: "initialize requires a protocolVersion string.",
          data: {
            supported: SUPPORTED_MCP_PROTOCOL_VERSIONS,
            requested: requestedVersion ?? null
          }
        }
      });
    }
    const protocolVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : DEFAULT_MCP_PROTOCOL_VERSION;
    return requestResponse(request, {
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "gitmono-team-protocol", version: "0.1.0" }
      }
    });
  }
  if (request.method === "tools/list") {
    return requestResponse(request, { result: { tools: TOOL_DEFINITIONS } });
  }
  if (request.method === "tools/call") {
    const malformed = validateCallToolParams(request.params);
    if (malformed) return invalidParams(request, malformed);
    if (!TOOL_NAMES.has(request.params.name)) return invalidParams(request, "Unknown tool.");
    try {
      const toolArguments = Object.prototype.hasOwnProperty.call(request.params, "arguments")
        ? request.params.arguments
        : {};
      const result = await dispatcher.call(request.params.name, toolArguments);
      return requestResponse(request, { result: toolResult(result) });
    } catch (error) {
      return requestResponse(request, {
        result: toolResult({ error: error.message, details: error.details ?? [] }, true)
      });
    }
  }
  return requestResponse(request, { error: { code: -32601, message: "Method not found." } });
}

export async function startServer() {
  const dispatcher = createDispatcher();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let response;
    try {
      response = await handleRequest(JSON.parse(line), dispatcher);
    } catch (error) {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } };
    }
    if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
