# GitMono Agent Team

面向 **Libra + Monorepo** 的最小三 Agent 协作仓库。它不负责替代模型或代码托管平台，而是把三个角色之间必须共享的工程契约固化为可验证文件和一个本地 MCP 服务：

- **Implementer（实现）**：在锁定的 `baseCommit` 上完成受限范围的改动，交付 PatchSet 与自测证据。
- **Verifier（验证）**：独立复跑验收、记录失败原因或通过证据，不能绕过测试结论。
- **Integrator（集成）**：检查基线、路径冲突、审查结论和风险门禁；只提交“允许合并”的决定，不直接替代人工审批。

仓库以 Git submodule 固定 Mega、ScorpioFS 和 Libra 的上游版本，并提供 [Mega + ScorpioFS Docker Compose](deploy/README.md) 用于本地部署。

架构遵循 GitMono 方案中的链路：**IntentSpec → Task → PatchSet → Evidence → Decision**。Libra 保存会话、checkpoint 与版本化证据；本仓库的 `team-protocol` MCP 只负责角色间的结构化交接和合并门禁。

## 快速开始

1. 安装并初始化 Libra（或将现有 Git 仓库转换为 Libra 仓库）。

   ```powershell
   libra init --from-git-repository <your-repository>
   cd <your-repository>
   libra agent enable
   ```

2. 在本仓库安装 lockfile 固定的运行时依赖。

   ```powershell
   Set-Location -LiteralPath '<ABSOLUTE_PATH_TO_THIS_REPOSITORY>'
   npm ci
   ```

3. 按客户端选择配置模板，并替换其中的两个绝对路径占位符：

   - Codex：将 [mcp/codex.config.toml.example](mcp/codex.config.toml.example) 中的配置段合并到 `config.toml`。
   - 接受顶层 `mcpServers` JSON 的客户端：使用 [mcp/mcp.template.json](mcp/mcp.template.json)。

   两种格式不能直接互换；完整说明见 [mcp/README.md](mcp/README.md)。`libra` 是 Libra 的 stdio MCP；`team-protocol` 是本仓库提供的协作接口。

4. 复制 [examples/intent-spec.example.json](examples/intent-spec.example.json)，为一次工作创建 IntentSpec。将同一文件、同一 `baseCommit` 交给三个 Agent。

5. 按以下顺序交接：Implementer → Verifier → Integrator。每次交接由 `team.submit_handoff` 写入 `.agent-team/handoffs.jsonl`；Integrator 审查前调用 `team.get_gate` 做前置条件预检。提交批准后再次调用：低/中风险以 `readyToMerge` 作为最终门禁，高风险则交由 MCP 外部授权人工门禁完成最终决定。

   ```powershell
   npm test
   npm run demo
   ```

## 目录

```text
agents/                   三个角色的系统提示与边界
skills/                   三个角色可安装的 Agent Skill
contracts/                IntentSpec、Handoff 的 JSON Schema
mcp/                      MCP 客户端配置模板与工具契约
src/mcp-server.js         执行 JSON Schema 输入校验的 stdio MCP 服务
src/protocol.js           校验、路由与合并门禁逻辑
examples/                 可复制的 IntentSpec / Handoff 样例
deploy/                   Mega + ScorpioFS Compose 与安装说明
submodules/               固定版本的 Mega、ScorpioFS、Libra 上游仓库
test/                     协议与 MCP 调用测试
```

## 不可变协作规则

1. `baseCommit` 是本轮协作的基线；任一 Agent 发现不一致必须阻塞交接。
2. Implementer 只交付指定 `allowedPaths` 内的 PatchSet 和其自测；Verifier 不修改同一 PatchSet。
3. Verifier 的 `passed` 交接必须包含通过的 `test` 证据；失败必须回传 Implementer。
4. Integrator 的 `approved` 决定必须建立在同一 `patchRef` 的实现、通过测试和通过审查三类顺序证据之上；新 PatchSet 会使旧验证与旧审批失效。
5. `risk: high` 永远由外部授权的人工门禁决定；Agent Handoff 不能自报 `human_approval`，本地 MCP 始终返回 `readyToMerge: false` 与 `externalHumanApprovalRequired: true`。外部门禁必须独立读取 IntentSpec 并核对精确的风险、基线及非人工门禁字段。
6. 每次交接都应写入可选的 Libra `sessionId` / `checkpointId`，使审计可追到 Think + Code 过程。
7. `ready`、`passed`、`approved` 等正向交接不得夹带任何 `failed` / `rejected` 证据；发现矛盾时必须失败关闭门禁。

## MCP 工具

内置 stdio 服务当前锁定 legacy MCP `2025-11-25`；它不会宣告支持尚未实现的 `2026-07-28` stateless/discovery 协议。

| 工具 | 写入 | 用途 |
| --- | --- | --- |
| `team.get_task` | 否 | 读取指定角色的输入、输出与允许交接方向。 |
| `team.submit_handoff` | 是 | 验证并持久化一份角色交接记录。 |
| `team.list_handoffs` | 否 | 按 Intent 查询已交接的证据链。 |
| `team.get_gate` | 否 | 计算当前 Intent 是否达到合并门禁。 |

完整输入输出见 [mcp/tools.md](mcp/tools.md)。JSON Schema 可用于 CI、Hook 或其他编排器；本服务不调用 LLM，也不直接执行 `git merge`。

## 与 Libra 的关系

Libra 是 Git 兼容、面向 Agent 的版本控制层，可捕获 Agent session 和 checkpoint，并原生提供 MCP 接入。其 stdio MCP 的进程启动参数为：

```json
{
  "command": "libra",
  "args": ["code", "--stdio"]
}
```

因此任务事实不在聊天窗口中漂移：IntentSpec 绑定 base commit，Handoff 绑定 PatchSet/Evidence，Libra trace 绑定会话与 checkpoint。详见 [Libra README](https://github.com/libra-tools/libra)。
