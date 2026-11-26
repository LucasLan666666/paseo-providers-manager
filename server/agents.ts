import type { Snapshot } from "../shared/contracts";
import { L } from "./i18n";

type Descriptor = Omit<Snapshot["agents"][number], "detail"> & { detail: [zh: string, en: string] };

const descriptors: Descriptor[] = [
  {
    id: "claude",
    label: "Claude Code",
    protocols: ["anthropic"],
    detail: ["Anthropic Messages 网关，使用 Claude Code 的原生上下文管理。", "Anthropic Messages gateway, with Claude Code's own context management."],
  },
  {
    id: "codex",
    label: "Codex",
    protocols: ["responses"],
    detail: ["OpenAI Responses 网关，按模型配置 Codex 目录。", "OpenAI Responses gateway, with a per-model Codex catalog."],
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    protocols: ["chat", "responses", "anthropic"],
    detail: ["通过 Copilot CLI 的自定义提供商连接网关。", "Connects the gateway through the Copilot CLI's custom providers."],
  },
  {
    id: "opencode",
    label: "OpenCode",
    protocols: ["chat", "anthropic", "responses"],
    detail: ["按模型写入上下文窗口和最大输出。", "Writes the context window and max output per model."],
  },
  {
    id: "pi",
    label: "Pi",
    protocols: ["chat", "responses", "anthropic"],
    detail: ["启用模型需要上下文窗口和最大输出。", "Enabled models need a context window and max output."],
  },
  {
    id: "omp",
    label: "Oh My Pi",
    protocols: ["chat", "responses", "anthropic"],
    detail: ["启用模型需要上下文窗口和最大输出。", "Enabled models need a context window and max output."],
  },
  {
    id: "antigravity",
    label: "Antigravity",
    protocols: ["gemini"],
    detail:
      ["通过原生 agy ACP 会话连接 Gemini 兼容网关；agy ACP 只能选择内置模型名（gemini-4-*、gemini-3.* 等）。", "Gemini-compatible gateway through native agy ACP sessions; agy ACP can only select its built-in model names (gemini-4-*, gemini-3.*, …)."],
  },
  {
    id: "muse",
    label: "Muse Code",
    protocols: [],
    detail: ["使用 Muse 登录和模型目录。目前缺少可验证的自定义推理网关接口。", "Uses the Muse login and model list. There is no verifiable custom inference gateway yet."],
  },
  {
    id: "fx",
    label: "fx",
    protocols: ["chat", "responses", "anthropic"],
    detail: ["fx ACP 使用独立的网关配置和逐模型参数。", "fx ACP with its own gateway settings and per-model parameters."],
  },
  {
    id: "hoplite",
    label: "Hoplite",
    protocols: [],
    detail:
      ["模型由 Hoplite 云项目和订阅决定；本地 ACP 桥接仅能选择项目提供的模型。", "Models come from the Hoplite cloud project and subscription; the local ACP bridge can only select the project's models."],
  },
];

/** Agent descriptors; `detail` in Chinese (labels and protocols are language-neutral). */
export const agents: Snapshot["agents"] = descriptors.map(({ detail, ...rest }) => ({ ...rest, detail: detail[0] }));

/** Agent descriptors with `detail` in the current request's language. */
export function localizedAgents(): Snapshot["agents"] {
  return descriptors.map(({ detail, ...rest }) => ({ ...rest, detail: L(detail[0], detail[1]) }));
}
