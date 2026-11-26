import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentId, Protocol } from "../shared/contracts";
import { protocolInfo } from "../shared/protocols";

/** The fields the manager asks an adapter to turn into a native provider. */
export interface AdapterModel {
  id: string;
  label: string;
  context?: number;
  output?: number;
  /** Where each limit came from; Claude Code / Codex only receive non-built-in ones. */
  contextSource?: "manual" | "gateway" | "catalog" | "fallback";
  outputSource?: "manual" | "gateway" | "catalog" | "fallback";
  caps?: { reasoning: boolean; image: boolean; tools: boolean };
  /** False for embedding/image/… models; adapters skip them where it matters. */
  chat?: boolean;
}

/** The connection fields an adapter needs. SavedConnection is structurally compatible. */
export interface AdapterConnection {
  id: string;
  name: string;
  url: string;
  protocol: Protocol;
  key: string;
}

export type BuiltInProvider = "claude" | "codex" | "copilot" | "opencode" | "pi" | "omp";
export type ProviderExtends = BuiltInProvider | "acp";

export interface ProviderModelChoice {
  id: string;
  label: string;
  isDefault?: boolean;
}

/** The subset of Paseo's custom-provider entry an adapter owns. */
export interface BuiltProvider {
  extends: ProviderExtends;
  command?: string[];
  env: Record<string, string>;
  options?: Record<string, unknown>;
  disallowedTools?: string[];
  description?: string;
  models: ProviderModelChoice[];
}

export const GATEWAY_KEY_ENV = "PPM_GATEWAY_KEY";
export const MODEL_PREFIX = "ppm";

const MODEL_ID = /^[^\0\r\n]{1,2048}$/;

export function assertModels(models: readonly AdapterModel[]): void {
  if (!models.length) throw new Error("至少选择一个模型后再启用该 agent。");
  const seen = new Set<string>();
  for (const model of models) {
    if (typeof model.id !== "string" || !MODEL_ID.test(model.id))
      throw new Error("模型 ID 不能为空，且不能包含控制字符。");
    if (seen.has(model.id)) throw new Error(`模型 ${model.id} 重复启用。`);
    seen.add(model.id);
  }
}

export function assertProtocol(
  agent: string,
  protocol: Protocol,
  supported: readonly Protocol[],
): void {
  if (!supported.includes(protocol)) {
    throw new Error(
      `${agent} 不支持 ${protocolInfo[protocol].label} 协议；可用协议：${supported
        .map((item) => protocolInfo[item].label)
        .join("、")}。`,
    );
  }
}

/** Validate and normalize an HTTP(S) gateway base URL. */
export function endpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("网关地址无效。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("网关地址必须使用 HTTP 或 HTTPS。");
  if (url.username || url.password)
    throw new Error("网关地址不能包含用户名或密码。");
  if (url.search || url.hash)
    throw new Error("网关地址不能包含查询参数或片段。");
  return url.href.replace(/\/+$/, "");
}

/**
 * OpenAI-compatible bases are used exactly as entered: the CLI appends
 * /chat/completions or /responses. Whether a gateway needs /v1 is the user's
 * call (some relays serve both); discovery uses the same base (catalog.ts).
 */
export function openAiBase(raw: string): string {
  return endpoint(raw);
}

/** Anthropic SDKs add /v1 themselves, so accept either host root or a /v1 base. */
export function anthropicBase(raw: string): string {
  const url = new URL(endpoint(raw));
  url.pathname = url.pathname.replace(/\/v1\/?$/, "") || "/";
  return url.href.replace(/\/+$/, "");
}

/** OpenCode's Anthropic package expects the versioned base. */
export function anthropicBaseV1(raw: string): string {
  const base = anthropicBase(raw);
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

/** Gemini native SDKs append /v1beta, so strip a version the user included. */
export function geminiBase(raw: string): string {
  const url = new URL(endpoint(raw));
  url.pathname = url.pathname.replace(/\/v1beta\/?$/, "").replace(/\/v1\/?$/, "") || "/";
  return url.href.replace(/\/+$/, "");
}

/**
 * Paseo/pi/omp/opencode name models provider/model. Antigravity's ACP model
 * list only contains its effort-qualified built-ins, so map a gateway base id
 * onto the matching built-in instead of sending an id ACP will reject.
 */
const ANTIGRAVITY_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  "gemini-4-neon": ["low", "medium", "high", "xhigh"],
  "gemini-4-carbon": ["low", "medium", "high"],
  "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
  "gemini-4-argon": ["low", "medium", "high"],
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.6-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
};

export function antigravityPickerId(rawId: string): string | undefined {
  const id = rawId.trim().replace(/^models\//, "");
  const match = /^(.*)-(low|medium|high|xhigh)$/.exec(id);
  if (match) {
    const efforts = ANTIGRAVITY_EFFORTS[match[1]];
    return efforts?.includes(match[2]) ? id : undefined;
  }
  if (ANTIGRAVITY_EFFORTS[id]) {
    // High exists for every ACP-listed Antigravity model; medium does not for 3.1 Pro.
    return `${id}-high`;
  }
  return undefined;
}

export function pickerModelId(agent: AgentId, rawId: string): string {
  switch (agent) {
    case "copilot":
    case "opencode":
    case "pi":
    case "omp":
      return `${MODEL_PREFIX}/${rawId}`;
    case "antigravity":
      return antigravityPickerId(rawId) ?? rawId;
    default:
      return rawId;
  }
}

export function modelChoices(
  agent: AgentId,
  models: readonly AdapterModel[],
): ProviderModelChoice[] {
  const seen = new Set<string>();
  return models.map((model, index) => {
    const id = pickerModelId(agent, model.id);
    if (seen.has(id))
      throw new Error(
        `模型 ${model.id} 映射到重复的选择 ID ${id}，请只启用其中一个（Antigravity 使用 -low/-medium/-high/-xhigh 变体）。`,
      );
    seen.add(id);
    return {
      id,
      label: model.label.trim() || model.id,
      ...(index === 0 ? { isDefault: true } : {}),
    };
  });
}

export function requireLimits(
  agent: string,
  models: readonly AdapterModel[],
): Array<AdapterModel & { context: number; output: number }> {
  for (const model of models) {
    if (!model.context || !model.output)
      throw new Error(
        `${agent} 需要模型 ${model.id} 的上下文窗口和最大输出，请填写后再启用。`,
      );
  }
  return models as Array<AdapterModel & { context: number; output: number }>;
}

export function privateDir(path: string): string {
  return resolve(path);
}

export async function ensurePrivateDir(path: string): Promise<string> {
  const target = privateDir(path);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  return target;
}

export async function writePrivateFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function childDir(dir: string, name: string): string {
  return join(privateDir(dir), name);
}
