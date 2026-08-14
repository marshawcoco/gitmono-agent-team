# GitMono Agent Team 协作约定

所有 Agent 必须先读取本轮 IntentSpec，再开始调用工具或修改代码。

- 不得修改 IntentSpec 的 `baseCommit`、`risk` 或 `allowedPaths`；发现不适配时以 `blocked` Handoff 退回。
- 每个 Handoff 都要带 `intentId`、`taskId`、`baseCommit`、`from`、`to`、`status`、`evidence` 与 Libra trace（如已启用）。
- Agent 只能提交自己职责范围内的交接：实现 → 验证；验证 → 实现或集成；集成 → 人工审批或任务结束。
- 每次 Handoff 前应调用 `team.get_gate` 或复核本轮已有 Handoff，防止基线不一致和证据遗漏。
- 不得以口头“已测试”替代结构化测试证据；高风险变更不能自动合并。

角色详细提示分别位于 `agents/`，可安装的工作流提示位于 `skills/`。
