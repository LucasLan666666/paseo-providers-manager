import type { Snapshot } from "../shared/contracts";

export const agents: Snapshot["agents"] = [
  {
    id: "claude",
    label: "Claude Code",
    protocols: ["anthropic"],
    detail: "Anthropic Messages 网关，使用 Claude Code 的原生上下文管理。",
  },
  {
    id: "codex",
    label: "Codex",
    protocols: ["responses"],
    detail: "OpenAI Responses 网关，按模型配置 Codex 目录。",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    protocols: ["chat", "responses", "anthropic"],
    detail: "通过 Copilot CLI 的自定义提供商连接网关。",
  },
  {
    id: "opencode",
    label: "OpenCode",
    protocols: ["chat", "anthropic", "responses"],
    detail: "按模型写入上下文窗口和最大输出。",
  },
  {
    id: "pi",
    label: "Pi",
    protocols: ["chat", "responses", "anthropic"],
    detail: "启用模型需要上下文窗口和最大输出。",
  },
  {
    id: "omp",
    label: "Oh My Pi",
    protocols: ["chat", "responses", "anthropic"],
    detail: "启用模型需要上下文窗口和最大输出。",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    protocols: ["gemini"],
    detail:
      "通过原生 agy ACP 会话连接 Gemini 兼容网关；agy ACP 只能选择内置模型名（gemini-4-*、gemini-3.* 等）。",
  },
  {
    id: "muse",
    label: "Muse Code",
    protocols: [],
    detail: "使用 Muse 登录和模型目录。目前缺少可验证的自定义推理网关接口。",
  },
  {
    id: "fx",
    label: "fx",
    protocols: ["chat", "responses", "anthropic"],
    detail: "fx ACP 使用独立的网关配置和逐模型参数。",
  },
  {
    id: "hoplite",
    label: "Hoplite",
    protocols: [],
    detail:
      "模型由 Hoplite 云项目和订阅决定；本地 ACP 桥接仅能选择项目提供的模型。",
  },
];
