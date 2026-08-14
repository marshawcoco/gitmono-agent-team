# MCP 客户端配置

本目录提供两种客户端配置格式。它们表达相同的两个 stdio MCP 服务，但不能互相直接粘贴：

- [codex.config.toml.example](codex.config.toml.example)：用于 Codex。将两个 `mcp_servers` 配置段合并到用户级 `~/.codex/config.toml`，或受信任项目下的 `.codex/config.toml`。
- [mcp.template.json](mcp.template.json)：仅用于接受顶层 `mcpServers` JSON 对象的客户端。这不是通用 MCP 配置格式，也不适用于 Codex 的 `config.toml`。

使用任一模板前，都需要替换两个绝对路径占位符：

- `<ABSOLUTE_PATH_TO_YOUR_LIBRA_REPOSITORY>`：需要由 Libra 管理的目标代码仓库。
- `<ABSOLUTE_PATH_TO_THIS_REPOSITORY>`：本 Agent Team 仓库，也就是包含 `src/mcp-server.js` 的目录。

`libra` 和 `node` 命令必须在启动客户端的环境中可执行。Codex 模板对路径使用 TOML 单引号字符串，因此 Windows 绝对路径中的反斜杠不需要额外转义。

Codex 的配置字段、配置位置与命令行管理方式见 [Codex MCP 官方文档](https://developers.openai.com/codex/mcp/)。
