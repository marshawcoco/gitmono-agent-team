# Team Protocol MCP

`src/mcp-server.js` 是 stdio MCP 服务。它使用 lockfile 固定的 Ajv 在启动时编译并执行每个工具公开的 `inputSchema`，再将有效交接追加到工作目录的 `.agent-team/handoffs.jsonl`；它不会启动模型、执行 shell 命令或合并代码。

符合 JSON-RPC 的通知没有 `id`，服务会处理或忽略它们，但绝不会向 stdout 写 Response；带显式 `id: null` 的消息仍是请求并会收到响应。

当前服务明确实现 legacy MCP `2025-11-25`：`initialize` 只会协商并返回这个版本，绝不会原样声明未实现的客户端版本。`server/discover` 返回标准的 Method not found，供支持双时代协商的客户端识别为 legacy 服务并按需降级。MCP `2026-07-28` 的无握手、每请求元数据模式尚未实现。

## `team.get_task`

读取角色的固定职责、输入、输出和允许交接路线。

```json
{ "agentId": "verifier" }
```

## `team.submit_handoff`

校验 Handoff 路线和证据，再持久化。省略 `handoffId` / `createdAt` 时服务会生成它们。

```json
{
  "intentId": "add-session-timeout",
  "taskId": "verify-session-timeout",
  "baseCommit": "a5bf591",
  "from": "verifier",
  "to": "integrator",
  "status": "passed",
  "summary": "Acceptance and regression tests passed independently.",
  "evidence": [
    {
      "kind": "test",
      "result": "passed",
      "command": "npm test -- session-timeout",
      "summary": "18 tests passed"
    }
  ]
}
```

有效路线：

| 角色 | 状态 | 收件人 |
| --- | --- | --- |
| `implementer` | `ready` / `blocked` | `verifier` |
| `verifier` | `needs_changes` / `blocked` | `implementer` |
| `verifier` | `passed` | `integrator` |
| `integrator` | `approved` / `blocked` | `human` 或 `orchestrator` |

正向证据链中的 Implementer `ready`、Verifier `passed` 与 Integrator `approved` 必须携带完全相同的 `patchRef`。每个阶段还必须追加在它所验证的前一阶段之后；新的 Implementer Handoff 会使旧验证与旧审批失效。

`ready`、`passed`、`approved` 等正向交接不能包含任何 `failed` 或 `rejected` evidence。提交时会拒绝这种矛盾记录；门禁读取旧记录时也会按失败关闭处理。先前失败应保留在独立的 `blocked` / `needs_changes` Handoff 中；正向 Handoff 可用 `finding: info` 引用其历史，但不能重新夹带负向结果。

## `team.list_handoffs`

按 Intent 查询已持久化记录。`intentId` 可选。

```json
{ "intentId": "add-session-timeout" }
```

## `team.get_gate`

计算合并前门禁。高风险任务还需要 Integrator 的 `human_approval: approved` evidence。

```json
{ "intentId": "add-session-timeout", "risk": "medium", "baseCommit": "a5bf591" }
```

返回字段：`implementerDelivered`、`verificationPassed`、`testEvidencePassed`、`reviewApproved`、`patchRefConsistent`、`blockingEvidenceAbsent`、`baseCommitConsistent`、`humanApproval`、`integrationPrerequisitesMet` 与最终的 `readyToMerge`。

Integrator 应始终使用 IntentSpec 中精确的 `intentId`、`risk` 与 `baseCommit` 分两阶段调用门禁。审查前的 preflight 只要求 `integrationPrerequisitesMet: true`，它聚合 Implementer 交付、Verifier 通过及测试证据、`patchRef` 一致、无阻断证据和基线一致；提交 `approved` Handoff 后的 postflight 才要求 `readyToMerge: true`。`integrationPrerequisitesMet` 不包含 Integrator 自己的审查或高风险人工审批，因此绝不等同于可合并。

## 错误语义

不存在的工具、缺失/非法的 `tools/call.params`、非字符串 `name`、非对象 `arguments`，以及服务未声明支持的 task-augmented 调用会返回 JSON-RPC `-32602` Protocol Error。已找到工具并开始执行后的可纠正输入或业务失败保留在 Tool Result 中，并设置 `isError: true`，便于 Agent 调整参数后重试。
