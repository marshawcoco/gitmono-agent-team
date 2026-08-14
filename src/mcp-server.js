import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AGENT_IDS, ROLE_TASKS, deriveGate, validateHandoff } from "./protocol.js";

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
        handoffId: { type: "string" },
        intentId: { type: "string" },
        taskId: { type: "string" },
        baseCommit: { type: "string" },
        from: { type: "string", enum: AGENT_IDS },
        to: { type: "string", enum: ["implementer", "verifier", "integrator", "human", "orchestrator"] },
        status: { type: "string", enum: ["ready", "passed", "needs_changes", "approved", "blocked"] },
        patchRef: { type: "string" },
        changedPaths: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
        evidence: { type: "array" },
        libra: { type: "object" },
        createdAt: { type: "string" }
      }
    }
  },
  {
    name: "team.list_handoffs",
    description: "List persisted handoffs, optionally limited to an IntentSpec.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { intentId: { type: "string" } }
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
        intentId: { type: "string" },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        baseCommit: { type: "string" }
      }
    }
  }
]);

function protocolError(message, details = []) {
  const error = new Error(message);
  error.details = details;
  return error;
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
          return deriveGate({ handoffs, ...args });
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

export async function handleRequest(request, dispatcher) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request." } };
  }
  if (request.method === "notifications/initialized") return undefined;

  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "gitmono-team-protocol", version: "0.1.0" }
      }
    };
  }
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools: TOOL_DEFINITIONS } };
  }
  if (request.method === "tools/call") {
    try {
      const result = await dispatcher.call(request.params?.name, request.params?.arguments ?? {});
      return { jsonrpc: "2.0", id: request.id, result: toolResult(result) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: toolResult({ error: error.message, details: error.details ?? [] }, true)
      };
    }
  }
  return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found." } };
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
