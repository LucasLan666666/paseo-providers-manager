import type { Protocol } from "./contracts";
import type { Lang } from "./i18n";

/**
 * User-facing protocol names, shared by the client and server messages.
 * "Chat" and "Responses" are both OpenAI protocols, so every label names the
 * vendor; a bare "OpenAI" choice was ambiguous and led to Chat connections that
 * Codex (Responses only) could not use.
 */
export const protocolInfo: Readonly<
  Record<Protocol, { label: string; short: string; endpoint: string }>
> = {
  chat: {
    label: "OpenAI Chat Completions",
    short: "OpenAI Chat",
    endpoint: "POST {base}/chat/completions",
  },
  responses: {
    label: "OpenAI Responses",
    short: "OpenAI Responses",
    endpoint: "POST {base}/responses",
  },
  anthropic: {
    label: "Anthropic Messages",
    short: "Anthropic",
    endpoint: "POST {host}/v1/messages",
  },
  gemini: {
    label: "Google Gemini",
    short: "Gemini",
    endpoint: "POST {host}/v1beta/models/{model}:generateContent",
  },
};

/** The OpenAI pair is the only switch where the same base URL usually serves both. */
export function counterpartProtocol(protocol: Protocol): Protocol | undefined {
  if (protocol === "chat") return "responses";
  if (protocol === "responses") return "chat";
  return undefined;
}

const PLACEHOLDERS: Record<Lang, Record<string, string>> = {
  "zh-CN": { "{base}": "{地址}", "{host}": "{主机}", "{model}": "{模型}" },
  en: { "{base}": "{base}", "{host}": "{host}", "{model}": "{model}" },
};

/** The request a gateway must serve, with placeholders in the reader's language. */
export function protocolEndpoint(protocol: Protocol, lang: Lang): string {
  return protocolInfo[protocol].endpoint.replace(/\{(base|host|model)\}/g, (token) => PLACEHOLDERS[lang][token] ?? token);
}
