# Team Protocol MCP

`src/mcp-server.js` 是无依赖的 stdio MCP 服务。它将所有交接追加到工作目录的 `.agent-team/handoffs.jsonl`，不会启动模型、执行 shell 命令或合并代码。符合 JSON-RPC 的通知没有 `id`，服务会处理或忽略它们，但绝不会向 stdout 写 Response；带显式 `id: null` 的消息仍是请求并会收到响应。

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

## `team.list_handoffs`

按 Intent 查询已持久化记录。`intentId` 可选。

```json
{ "intentId": "add-session-timeout" }
```

## `team.get_gate`

计算合并前门禁。高风险任务还需要 Integrator 的 `human_approval: approved` evidence。

```json
{ "intentId": "add-session-timeout", "risk": "medium" }
```

返回字段：`implementerDelivered`、`verificationPassed`、`testEvidencePassed`、`reviewApproved`、`baseCommitConsistent`、`humanApproval` 与最终的 `readyToMerge`。
