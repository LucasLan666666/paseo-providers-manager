# Providers Manager

Providers Manager 从 Paseo 侧边栏打开：选择 agent，添加或复用网关连接，勾选要放入新建会话选择器的模型。每个 agent 有自己的启用列表、模型修正值和默认限额。共享连接上的地址或密钥变更会用于引用它的配置。

需要 Paseo 0.17.4 或更新的兼容版本，并在 daemon 所在主机安装相应 CLI。管理页会显示每个 agent 的接入方式：

- **Claude Code**：Anthropic Messages 网关。
- **Codex**：OpenAI Responses 网关。
- **GitHub Copilot**：Chat Completions、Responses 或 Anthropic Messages 网关，通过 Copilot CLI 的 providers 配置。
- **OpenCode**：Chat Completions、Responses 或 Anthropic Messages 网关，逐模型写入上下文窗口和最大输出。
- **Pi / Oh My Pi**：Chat Completions、Responses 或 Anthropic Messages 网关，逐模型写入上下文窗口和最大输出；缺少这两项时不能启用。
- **Antigravity**：Gemini 兼容网关 + 原生 agy ACP 会话。agy ACP 的模型选择器只接受它内置的模型名（例如 `gemini-4-argon`、`gemini-3.1-pro`，可带 `-low/-medium/-high/-xhigh`）；插件会把网关模型映射到这些名称，其他模型名无法通过 ACP 选择。agy 自身的辅助请求也会经过同一网关。
- **fx**：Chat Completions、Responses 或 Anthropic Messages 网关，写入 fx 的 `settings.json`。
- **Muse Code / Hoplite**：没有可验证的自定义推理网关接口，只能检查并使用各自账号的模型目录。

保存连接时会获取完整模型目录。打开页面时会刷新超过 24 小时的目录，也可手动刷新。插件优先使用网关提供的参数，缺少的字段按服务商和模型 ID 从 models.dev 精确匹配。自定义地址可指定目录供应商 ID。无可靠匹配的字段保留为空，可填写 agent 默认值或手动修正。手填值与新获取的数据冲突时，可比较两个值再选择。已启用的模型从目录消失后仍然可用，页面会标记其状态。

「测试全部模型」只重新读取模型目录并校验模型参数，不会创建会话或发送推理消息，因此不消耗模型 token。启用的组合会在 Paseo 中生成独立的 provider，名称包含 agent 和连接名称。生成目录在配置变化后保留一段时间，避免正在运行的会话立即失去配置；之后由插件清理。

连接密钥以明文保存于 daemon 主机的受限数据目录 `$PASEO_HOME/plugin-data/paseo-providers-manager/`，相应 CLI 的启动配置也可能在 Paseo 配置或生成的本地文件中包含密钥。已保存的密钥不会返回管理页。网关收到目录请求和所选 agent 发出的模型请求。公共目录请求使用独立的无凭据连接。首版独立存储数据，不导入 Model Providers 的旧配置。
