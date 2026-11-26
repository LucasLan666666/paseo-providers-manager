# Providers Manager

从 Paseo 侧边栏打开 Providers Manager：选择 Agent，添加或复用网关连接，勾选要放入新建会话选择器的模型。每个连接上的模型上下文窗口、最大输出和能力（推理、图片输入、工具调用）由连接上的所有 Agent 共用；模型选择和默认模型属于各个 Agent。共享连接上的地址或密钥变更会用于引用它的所有配置。

需要 Paseo 0.17.4 或更新的兼容版本，并在 daemon 所在主机安装相应 CLI。管理页会显示每个 Agent 的接入方式：

- **Claude Code**：Anthropic Messages 网关。只有 Claude Code 不认识的模型，或手动填写的值，才会写入上限。
- **Codex**：OpenAI Responses 网关。精确匹配 Codex 内置表的模型保留其上限和推理强度档位；按连接配置的别名映射、允许档位和手动值写入生成的模型目录。
- **GitHub Copilot**：Chat Completions、Responses 或 Anthropic Messages 网关，通过 Copilot CLI 的 providers 配置。
- **OpenCode**：Chat Completions、Responses 或 Anthropic Messages 网关，逐模型上限、能力与密钥写入私有文件，并在打开会话时按连接注入以隔离多个网关。
- **Pi / Oh My Pi**：Chat Completions、Responses 或 Anthropic Messages 网关，逐模型写入上下文窗口、最大输出和能力。
- **Antigravity**：Gemini 兼容网关 + 原生 agy ACP 会话。agy ACP 的模型选择器只接受它内置的模型名（例如 `gemini-4-argon`、`gemini-3.1-pro`，可带 `-low/-medium/-high/-xhigh`）；插件会把网关模型映射到这些名称。
- **fx**：Chat Completions、Responses 或 Anthropic Messages 网关，写入 fx 的 `settings.json`。
- **Muse Code / Hoplite**：没有可验证的自定义推理网关接口，只能检查并使用各自账号的模型目录。

OpenAI 兼容网关的地址按填写的原样使用，插件不会自动补 `/v1`。Anthropic 和 Gemini 网关可以填主机根地址，也可以带版本路径，它们的 API 路径（`/v1/messages`、`/v1beta/models`）按各自客户端的约定补全。

## 上下文窗口与最大输出

保存或刷新连接时，插件读取网关的模型目录，再按模型名在 [models.dev](https://models.dev) 中匹配，优先采用厂商自己的条目：

- 精确匹配的值直接使用，并标明来源。
- 按同系列推测的值、网上没有公布的输出上限、只在第三方目录中找到的值标为「待确认」，可逐个或一键采用。
- OpenAI 模型默认使用 272K 的计费档位，可对单个模型改用完整窗口。
- 嵌入、重排、图像等不能对话的模型会灰显，不能选择。
- 都查不到的模型使用连接的兜底值（默认 128K / 16K）。

手动值优先；网上的值之后变化时，可以比较两个值再选择。自动得到的最大输出不会达到上下文窗口。

## 测试

「测试全部模型」重新读取模型目录并检查实际会生成的参数，不发送推理请求，不消耗 token。模型面板中的「发送测试请求」会给已选的对话模型各发一条极短请求，结果标在每个模型上。

## 语言

在 设置 → 插件 → Providers Manager 中可以选择「跟随 Paseo」、「简体中文」或「English」。该设置保存在当前设备上。

## 数据与安全

连接密钥以明文保存于 daemon 主机的受限数据目录 `$PASEO_HOME/plugin-data/paseo-providers-manager/`，相应 CLI 的启动配置也可能在 Paseo 配置或生成的本地文件中包含密钥。已保存的密钥不会返回管理页。网关收到目录请求、测试请求和所选 Agent 发出的模型请求；复制连接时只有同一域名和端口才会沿用原密钥。models.dev 请求使用独立的无凭据连接。启用的组合会在 Paseo 中生成独立的 provider，名称包含 Agent 和连接名称；生成目录在配置变化后保留一段时间，避免正在运行的会话立即失去配置，之后由插件清理。
