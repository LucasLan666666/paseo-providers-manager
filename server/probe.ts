import type { Probe } from "../shared/contracts";
import { anthropicBase, geminiBase, openAiBase } from "./adapter-common";
import type { SavedConnection } from "./state";

const TIMEOUT_MS = 60_000;
const CONCURRENCY = 4;
const PROMPT = "Reply with: ok";
const MAX_BODY = 256 * 1024;

function hasErrorBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; type?: unknown };
    return (parsed.error !== undefined && parsed.error !== null) || parsed.type === "error";
  } catch {
    return false;
  }
}

interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** One tiny inference request in the connection's own protocol. */
function requestFor(conn: SavedConnection, model: string): ProbeRequest {
  const json = { "content-type": "application/json", accept: "application/json" };
  switch (conn.protocol) {
    case "chat":
      return {
        url: `${openAiBase(conn.url)}/chat/completions`,
        headers: { ...json, ...(conn.key ? { authorization: `Bearer ${conn.key}` } : {}) },
        // OpenAI reasoning models reject max_tokens; max_completion_tokens is the
        // current name and other gateways ignore a parameter they don't know.
        body: { model, messages: [{ role: "user", content: PROMPT }], max_completion_tokens: 32, stream: false },
      };
    case "responses":
      return {
        url: `${openAiBase(conn.url)}/responses`,
        headers: { ...json, ...(conn.key ? { authorization: `Bearer ${conn.key}` } : {}) },
        body: { model, input: PROMPT, max_output_tokens: 16, store: false },
      };
    case "anthropic":
      // Claude Code sends the key as a bearer token; native gateways read x-api-key.
      return {
        url: `${anthropicBase(conn.url)}/v1/messages`,
        headers: {
          ...json,
          "anthropic-version": "2023-06-01",
          ...(conn.key ? { "x-api-key": conn.key, authorization: `Bearer ${conn.key}` } : {}),
        },
        body: { model, max_tokens: 16, messages: [{ role: "user", content: PROMPT }] },
      };
    case "gemini":
      return {
        url: `${geminiBase(conn.url)}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { ...json, ...(conn.key ? { "x-goog-api-key": conn.key } : {}) },
        body: { contents: [{ role: "user", parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 16 } },
      };
  }
}

// The shared typings do not always expose the static Node helper.
function timeoutSignal(ms: number): AbortSignal | undefined {
  const timeout = (AbortSignal as unknown as { timeout?: (value: number) => AbortSignal }).timeout;
  return typeof timeout === "function" ? timeout.call(AbortSignal, ms) : undefined;
}

function errorText(status: number, body: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const raw =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : "";
    detail = raw;
  } catch {
    detail = body.trim().startsWith("<") ? "" : body.trim();
  }
  return `HTTP ${status}${detail ? ` ${detail}` : ""}`;
}

async function probeOne(
  conn: SavedConnection,
  model: string,
  fetchImpl: typeof fetch,
): Promise<Probe> {
  const request = requestFor(conn, model);
  const started = Date.now();
  const redact = (text: string) =>
    (conn.key ? text.split(conn.key).join("••••") : text).replace(/\s+/g, " ").slice(0, 300);
  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      // A redirect could carry the key to another host.
      redirect: "error",
      signal: timeoutSignal(TIMEOUT_MS),
    });
    const length = Number(response.headers.get("content-length") ?? 0);
    const body = length > MAX_BODY ? "" : (await response.text().catch(() => "")).slice(0, MAX_BODY);
    const ms = Date.now() - started;
    // Some relays answer 200 with an error object instead of a model reply.
    const failed = !response.ok || hasErrorBody(body);
    if (!failed) return { ok: true, ms, at: Date.now() };
    return { ok: false, ms, error: redact(errorText(response.status, body)), at: Date.now() };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    const message =
      name === "TimeoutError" || name === "AbortError"
        ? "请求超时"
        : `无法连接网关：${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, ms: Date.now() - started, error: redact(message), at: Date.now() };
  }
}

/** Send one request per model, a few at a time. Results are keyed by model id. */
export async function probeModels(
  conn: SavedConnection,
  models: readonly string[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Record<string, Probe>> {
  const queue = [...new Set(models)];
  const results: Record<string, Probe> = {};
  const worker = async () => {
    for (let model = queue.shift(); model !== undefined; model = queue.shift())
      results[model] = await probeOne(conn, model, fetchImpl);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return results;
}
