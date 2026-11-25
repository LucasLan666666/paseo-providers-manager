import type { Protocol } from "./contracts";

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
    endpoint: "POST {地址}/chat/completions",
  },
  responses: {
    label: "OpenAI Responses",
    short: "OpenAI Responses",
    endpoint: "POST {地址}/responses",
  },
  anthropic: {
    label: "Anthropic Messages",
    short: "Anthropic",
    endpoint: "POST {主机}/v1/messages",
  },
  gemini: {
    label: "Google Gemini",
    short: "Gemini",
    endpoint: "POST {主机}/v1beta/models/{模型}:generateContent",
  },
};

/** The OpenAI pair is the only switch where the same base URL usually serves both. */
export function counterpartProtocol(protocol: Protocol): Protocol | undefined {
  if (protocol === "chat") return "responses";
  if (protocol === "responses") return "chat";
  return undefined;
}
