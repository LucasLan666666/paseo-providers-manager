import type { Capacity, Model, Protocol } from "../shared/contracts";

/**
 * Provider model discovery.
 *
 * The discovery subset of a saved connection. Credentials are only ever sent
 * to the origin of `url`; the optional models.dev lookup is always anonymous.
 */
export interface CatalogConnection {
  url: string;
  protocol: Protocol;
  key: string;
  catalogProvider: string;
}

/**
 * Optional injection points, primarily for tests. Production callers only need
 * `discover(connection)`.
 */
export interface DiscoverOptions {
  /** Defaults to the platform `fetch`. */
  fetch?: typeof fetch;
  /** Replaces the models.dev lookup. Receives the explicit provider, or "". */
  loadCatalog?: (catalogProvider: string) => Promise<unknown>;
  /** Defaults to https://models.dev/api.json. */
  catalogUrl?: string;
  /** Per-request timeout for the provider endpoint. Defaults to 20s. */
  timeoutMs?: number;
  /** Per-request timeout for the catalog endpoint. Defaults to 30s. */
  catalogTimeoutMs?: number;
  /** Hard page cap while following pagination. Defaults to 100. */
  maxPages?: number;
  /** Hard model cap. Defaults to 10,000. */
  maxModels?: number;
  /** models.dev cache TTL. Defaults to 10 minutes; 0 disables the cache. */
  catalogCacheTtlMs?: number;
}

export type CatalogErrorCode =
  | "invalid-connection"
  | "invalid-url"
  | "network"
  | "auth"
  | "http"
  | "invalid-response"
  | "pagination";

/**
 * An expected discovery failure. Messages are deliberately free of URLs,
 * response bodies, and credentials so callers can display them verbatim.
 */
export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  readonly status: number | undefined;

  constructor(code: CatalogErrorCode, message: string, status?: number) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
    this.status = status;
  }
}

const PROTOCOLS: readonly Protocol[] = ["chat", "responses", "anthropic", "gemini"];
const DEFAULT_CATALOG_URL = "https://models.dev/api.json";
const DEFAULT_CATALOG_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PAGES = 1_000;
const MAX_MODELS = 100_000;
const MAX_MODEL_ID_LENGTH = 2_048;
// models.dev api.json is currently about 7 MB. This still guards against a
// gateway streaming an unbounded response without blocking normal payloads.
const MAX_RESPONSE_CHARS = 32 * 1024 * 1024;

const CONTEXT_PATHS = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_model_len",
  "max_input_tokens",
  "input_token_limit",
  "limit.context",
  "limits.context",
  "top_provider.context_length",
  "top_provider.max_context_length",
  "top_provider.max_input_tokens",
] as const;

const OUTPUT_PATHS = [
  "max_output_tokens",
  "max_completion_tokens",
  "output_token_limit",
  "max_tokens_output",
  "limit.output",
  "limits.output",
  "top_provider.max_completion_tokens",
  "top_provider.max_output_tokens",
] as const;

const GEMINI_CONTEXT_PATHS = ["inputTokenLimit", ...CONTEXT_PATHS] as const;
const GEMINI_OUTPUT_PATHS = ["outputTokenLimit", ...OUTPUT_PATHS] as const;

const PAGE_CURSOR_PARAMS = ["after_id", "before_id", "pageToken", "next_page_token"] as const;
const VERSION_SEGMENT = /^v\d+(?:(?:alpha|beta)\d*)?$/i;

interface Limits {
  context?: number;
  output?: number;
}

// The native function is captured once so a test stub assigned to
// globalThis.fetch is never mistaken for the production catalog cache owner.
const capturedDefaultFetch: typeof fetch | undefined =
  typeof globalThis.fetch === "function" ? globalThis.fetch : undefined;

let catalogCache: { url: string; data: unknown; expiresAt: number } | undefined;
let catalogRequest: { url: string; promise: Promise<unknown> } | undefined;

/** Drop the cached models.dev payload. Exposed for tests and forced refreshes. */
export function clearCatalogCache(): void {
  catalogCache = undefined;
  catalogRequest = undefined;
}

/**
 * Discover the models exposed by a provider endpoint.
 *
 * Supported protocols:
 *  - chat/responses: OpenAI-compatible `GET {base}/models` (the base normally
 *    already includes its version, e.g. `https://host/v1`)
 *  - anthropic: native `GET {base}/v1/models` with `after_id` pagination
 *  - gemini: native `GET {base}/v1beta/models` with `pageToken` pagination
 *
 * Gateway-provided limits always win. Missing context/output values are filled
 * from an exact models.dev provider + model match; absent matches stay absent.
 * When `catalogProvider` is blank, a unique provider is inferred by comparing
 * the connection's origin + path with models.dev `provider.api` (a trailing
 * slash and a single missing trailing version segment are equivalent).
 * Ambiguous or unknown endpoints remain unenriched.
 */
export async function discover(
  connection: CatalogConnection,
  options: DiscoverOptions = {},
): Promise<Model[]> {
  if (connection === null || typeof connection !== "object") {
    throw new CatalogError("invalid-connection", "缺少网关连接信息。");
  }

  const protocol = assertProtocol(connection.protocol);
  const base = normalizeBaseUrl(connection.url);
  const key = sanitizeKey(connection.key);
  const catalogProvider =
    typeof connection.catalogProvider === "string" ? connection.catalogProvider.trim() : "";
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new CatalogError("network", "当前运行环境不支持网络请求。");
  }

  const models = await collectModels(
    base,
    protocol,
    requestHeaders(protocol, key),
    fetchImpl,
    options,
  );

  if (models.some((model) => !model.context || !model.output)) {
    const catalog = await readCatalog(catalogProvider, fetchImpl, options);
    if (catalog !== undefined && catalog !== null) {
      const provider =
        catalogProvider !== "" ? catalogProvider : inferCatalogProvider(catalog, base);
      if (provider !== undefined) applyCatalog(models, catalog, provider);
    }
  }

  return models;
}

function assertProtocol(raw: unknown): Protocol {
  if (typeof raw !== "string" || !PROTOCOLS.includes(raw as Protocol)) {
    throw new CatalogError("invalid-connection", "不支持的网关协议。");
  }
  return raw as Protocol;
}

function sanitizeKey(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "";
  if (/[\u0000\r\n]/.test(raw)) {
    throw new CatalogError("invalid-connection", "API Key 包含无效字符。");
  }
  return raw;
}

function normalizeBaseUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new CatalogError("invalid-url", "请填写网关地址。");
  }

  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const hostPart = value.split(/[/?#]/, 1)[0] ?? "";
    value = `${isLocalHost(hostPart) ? "http" : "https"}://${value}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CatalogError("invalid-url", "网关地址无效。");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CatalogError("invalid-url", "网关地址必须使用 HTTP 或 HTTPS。");
  }
  if (url.username !== "" || url.password !== "") {
    throw new CatalogError("invalid-url", "网关地址不能包含用户名或密码。");
  }

  url.hash = "";
  return url;
}

function isLocalHost(hostPart: string): boolean {
  const host = hostPart
    .replace(/:\d+$/, "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "host.docker.internal" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  return false;
}

function initialModelsUrl(base: URL, protocol: Protocol): URL {
  const url = new URL(base.href);
  const path = url.pathname.replace(/\/+$/, "");

  if (!path.endsWith("/models")) {
    // OpenAI-style base URLs already carry their version (`.../v1`,
    // `.../v1beta/openai`). Anthropic and Gemini bases are usually host roots,
    // so add their native version when it is not already present.
    if (protocol === "anthropic") {
      url.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
    } else if (protocol === "gemini") {
      url.pathname =
        path.endsWith("/v1") || path.endsWith("/v1beta")
          ? `${path}/models`
          : `${path}/v1beta/models`;
    } else {
      // OpenAI bases are used as entered, exactly like the generated CLI configs.
      url.pathname = `${path}/models`;
    }
  } else {
    url.pathname = path;
  }
  // Ask for the largest documented page up front. Pagination still follows every
  // cursor, so this only reduces the number of round trips.
  if (protocol === "anthropic" && !url.searchParams.has("limit")) {
    url.searchParams.set("limit", "1000");
  }
  if (protocol === "gemini" && !url.searchParams.has("pageSize")) {
    url.searchParams.set("pageSize", "1000");
  }
  return url;
}

function requestHeaders(protocol: Protocol, key: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
  if (key === "") return headers;
  if (protocol === "anthropic") headers["x-api-key"] = key;
  else if (protocol === "gemini") headers["x-goog-api-key"] = key;
  else headers.authorization = `Bearer ${key}`;
  return headers;
}

async function collectModels(
  base: URL,
  protocol: Protocol,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  options: DiscoverOptions,
): Promise<Model[]> {
  const maxPages = resolveCountOption(options.maxPages, 100, MAX_PAGES);
  const maxModels = resolveCountOption(options.maxModels, 10_000, MAX_MODELS);
  const timeoutMs = resolveTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);

  let url: URL | undefined = initialModelsUrl(base, protocol);
  const visited = new Set<string>();
  const seenIds = new Set<string>();
  const models: Model[] = [];
  let pages = 0;

  while (url !== undefined) {
    if (pages >= maxPages) {
      throw new CatalogError("pagination", "网关返回了过多分页。");
    }
    if (visited.has(url.href)) {
      throw new CatalogError("pagination", "网关返回了重复的分页游标。");
    }
    visited.add(url.href);

    const payload = await requestJson(url, base.origin, headers, fetchImpl, timeoutMs);
    const { models: pageModels, record } = parsePage(protocol, payload);

    for (const model of pageModels) {
      if (seenIds.has(model.id)) continue;
      seenIds.add(model.id);
      models.push(model);
      if (models.length > maxModels) {
        throw new CatalogError("pagination", "网关返回了过多模型。");
      }
    }

    pages += 1;
    url = record === undefined ? undefined : nextPageUrl(protocol, record, url);
  }

  return models;
}

function resolveCountOption(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function resolveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMEOUT_MS);
}

function parsePage(
  protocol: Protocol,
  payload: unknown,
): { models: Model[]; record: Record<string, unknown> | undefined } {
  const items = extractItems(protocol, payload);
  const models: Model[] = [];
  for (const item of items) models.push(toModel(item, protocol));
  return { models, record: isRecord(payload) ? payload : undefined };
}

function extractItems(protocol: Protocol, payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) throw malformedModelList();

  // If the protocol's primary list field is present it must be the list. This
  // avoids turning a malformed page into an empty (and therefore complete-
  // looking) result just because a fallback field happens to exist.
  const preferred = protocol === "gemini" ? "models" : "data";
  const fallback = protocol === "gemini" ? "data" : "models";
  for (const key of [preferred, fallback]) {
    if (!Object.hasOwn(payload, key)) continue;
    const value = payload[key];
    if (!Array.isArray(value)) throw malformedModelList();
    return value;
  }
  throw malformedModelList();
}

function malformedModelList(): CatalogError {
  return new CatalogError("invalid-response", "网关返回的模型列表格式不正确。");
}

function toModel(item: unknown, protocol: Protocol): Model {
  if (typeof item === "string") {
    const id = normalizeId(item, protocol);
    if (id === undefined) throw malformedModelEntry();
    return { id, label: id, listed: true };
  }
  if (!isRecord(item)) throw malformedModelEntry();

  const rawId =
    protocol === "gemini"
      ? readString(item.name) ?? readString(item.id) ?? readString(item.model)
      : readString(item.id) ?? readString(item.name) ?? readString(item.model);
  const id = rawId === undefined ? undefined : normalizeId(rawId, protocol);
  if (id === undefined) throw malformedModelEntry();

  const label = modelLabel(item, protocol) ?? id;
  const context = gatewayLimit(item, protocol, "context");
  const output = gatewayLimit(item, protocol, "output");

  return {
    id,
    label,
    listed: true,
    ...(context === undefined ? {} : { context: capacity(context) }),
    ...(output === undefined ? {} : { output: capacity(output) }),
  };
}

function malformedModelEntry(): CatalogError {
  return new CatalogError("invalid-response", "网关返回的模型条目格式不正确。");
}

function normalizeId(value: string, protocol: Protocol): string | undefined {
  let id = value.trim();
  if (protocol === "gemini" && id.startsWith("models/")) {
    id = id.slice("models/".length).trim();
  }
  if (id === "" || id.length > MAX_MODEL_ID_LENGTH) return undefined;
  return id;
}

function modelLabel(item: Record<string, unknown>, protocol: Protocol): string | undefined {
  const keys =
    protocol === "gemini"
      ? (["displayName", "display_name", "label"] as const)
      : (["display_name", "displayName", "name", "label"] as const);
  for (const key of keys) {
    const value = readString(item[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function gatewayLimit(
  item: Record<string, unknown>,
  protocol: Protocol,
  field: "context" | "output",
): number | undefined {
  const paths =
    protocol === "gemini"
      ? field === "context"
        ? GEMINI_CONTEXT_PATHS
        : GEMINI_OUTPUT_PATHS
      : field === "context"
        ? CONTEXT_PATHS
        : OUTPUT_PATHS;

  for (const path of paths) {
    const parsed = positiveInteger(getPath(item, path));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function capacity(value: number): Capacity {
  return { value, source: "gateway" };
}

function nextPageUrl(
  protocol: Protocol,
  payload: Record<string, unknown>,
  current: URL,
): URL | undefined {
  const link = readNextLink(payload);
  if (link !== undefined) return sameOriginUrl(link, current);

  if (protocol === "gemini") {
    const token = readString(payload.nextPageToken) ?? readString(payload.next_page_token);
    return token === undefined ? undefined : withCursor(current, "pageToken", token);
  }

  if (protocol === "anthropic") {
    if (payload.has_more !== true) return undefined;
    return cursorPage(payload, current);
  }

  const token = readString(payload.nextPageToken) ?? readString(payload.next_page_token);
  if (token !== undefined) return withCursor(current, "pageToken", token);
  if (payload.has_more === true) return cursorPage(payload, current);
  return undefined;
}

function cursorPage(payload: Record<string, unknown>, current: URL): URL {
  const last = readString(payload.last_id) ?? readString(payload.lastId);
  if (last === undefined) {
    throw new CatalogError("pagination", "网关未返回分页游标。");
  }
  return withCursor(current, "after_id", last);
}

function withCursor(current: URL, param: string, value: string): URL {
  const next = new URL(current.href);
  for (const key of PAGE_CURSOR_PARAMS) {
    if (key !== param) next.searchParams.delete(key);
  }
  next.searchParams.set(param, value);
  return next;
}

function readNextLink(payload: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    payload.next,
    payload.next_page,
    isRecord(payload.links) ? payload.links.next : undefined,
    isRecord(payload.pagination) ? payload.pagination.next : undefined,
  ];

  for (const candidate of candidates) {
    const value = readString(candidate);
    if (value !== undefined && isLink(value)) return value;
  }
  return undefined;
}

function isLink(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("?") ||
    /^https?:\/\//i.test(value)
  );
}

function sameOriginUrl(value: string, current: URL): URL {
  let target: URL;
  try {
    target = new URL(value, current);
  } catch {
    throw new CatalogError("pagination", "网关返回了无效的分页链接。");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new CatalogError("pagination", "网关返回了无效的分页链接。");
  }
  if (target.username !== "" || target.password !== "") {
    throw new CatalogError("pagination", "网关返回了无效的分页链接。");
  }
  if (target.origin !== current.origin) {
    throw new CatalogError("pagination", "网关返回了跨域分页链接，已停止请求以保护密钥。");
  }

  target.hash = "";
  return target;
}

async function requestJson(
  url: URL,
  allowedOrigin: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  if (url.origin !== allowedOrigin) {
    throw new CatalogError("pagination", "网关返回了跨域分页链接，已停止请求以保护密钥。");
  }

  let response: Response;
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      headers,
      redirect: "error",
      signal: timeoutSignal(timeoutMs),
    });
  } catch (error) {
    throw networkError(error);
  }

  if (!response.ok) throw responseError(response.status);

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_CHARS) {
    throw new CatalogError("invalid-response", "网关响应过大。");
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new CatalogError("invalid-response", "无法读取网关响应。");
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new CatalogError("invalid-response", "网关响应过大。");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CatalogError("invalid-response", "网关返回了无法解析的响应。");
  }
}

function timeoutSignal(milliseconds: number): AbortSignal | undefined {
  // The DOM / React Native AbortSignal typings do not always expose the static
  // Node helper even though it is present at runtime. Probe it without letting
  // the shared client typings dictate server capabilities.
  const timeout = (
    AbortSignal as unknown as {
      timeout?: (value: number) => AbortSignal;
    }
  ).timeout;
  return typeof timeout === "function" ? timeout.call(AbortSignal, milliseconds) : undefined;
}

function networkError(error: unknown): CatalogError {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? (error as { name?: unknown }).name
      : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return new CatalogError("network", "网关请求超时。");
  }
  return new CatalogError("network", "无法连接网关，请检查地址和网络。");
}

function responseError(status: number): CatalogError {
  if (status === 401 || status === 403) {
    return new CatalogError("auth", "网关拒绝了 API Key，请检查密钥和权限。", status);
  }
  if (status === 404) {
    return new CatalogError("http", "找不到网关的模型列表接口。", status);
  }
  if (status === 429) {
    return new CatalogError("http", "网关请求过于频繁，请稍后再试。", status);
  }
  if (status >= 500) {
    return new CatalogError("http", "网关暂时不可用。", status);
  }
  return new CatalogError("http", `网关返回 HTTP ${status}。`, status);
}

// ---------------------------------------------------------------------------
// models.dev enrichment
// ---------------------------------------------------------------------------

/** The models.dev payload for name matching (shared 10-minute cache); null when unavailable. */
export function fetchCatalog(options: DiscoverOptions = {}): Promise<unknown | null> {
  return readCatalog("", options.fetch ?? globalThis.fetch, options);
}

async function readCatalog(
  catalogProvider: string,
  fetchImpl: typeof fetch,
  options: DiscoverOptions,
): Promise<unknown | null> {
  try {
    if (options.loadCatalog !== undefined) {
      return await options.loadCatalog(catalogProvider);
    }
    return await loadModelsDev(fetchImpl, options);
  } catch {
    // Catalog enrichment is optional. A catalog outage must never hide models
    // that the provider itself just returned.
    return null;
  }
}

async function loadModelsDev(
  fetchImpl: typeof fetch,
  options: DiscoverOptions,
): Promise<unknown> {
  const rawUrl = options.catalogUrl ?? DEFAULT_CATALOG_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CatalogError("invalid-url", "模型目录地址无效。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CatalogError("invalid-url", "模型目录地址必须使用 HTTP 或 HTTPS。");
  }
  if (url.username !== "" || url.password !== "") {
    throw new CatalogError("invalid-url", "模型目录地址不能包含用户名或密码。");
  }
  url.hash = "";

  const ttl = resolveCatalogTtl(options.catalogCacheTtlMs);
  const cacheable = fetchImpl === capturedDefaultFetch && ttl > 0;
  const href = url.href;

  if (cacheable && catalogCache?.url === href && catalogCache.expiresAt > Date.now()) {
    return catalogCache.data;
  }
  if (cacheable && catalogRequest?.url === href) {
    return catalogRequest.promise;
  }

  const promise = requestJson(
    url,
    url.origin,
    { accept: "application/json" },
    fetchImpl,
    resolveTimeout(options.catalogTimeoutMs, DEFAULT_CATALOG_TIMEOUT_MS),
  );

  if (!cacheable) return promise;

  const request = { url: href, promise };
  catalogRequest = request;
  try {
    const data = await promise;
    catalogCache = { url: href, data, expiresAt: Date.now() + ttl };
    return data;
  } finally {
    if (catalogRequest === request) catalogRequest = undefined;
  }
}

function resolveCatalogTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CATALOG_TTL_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_CATALOG_TTL_MS;
  return value;
}

interface CatalogProvider {
  id: string;
  entry: Record<string, unknown>;
}

/**
 * Infer a provider only when exactly one models.dev entry declares an `api`
 * URL for this connection's origin + base path. Public gateways that share an
 * official base URL are deliberately ambiguous and stay unenriched.
 */
function inferCatalogProvider(raw: unknown, base: URL): string | undefined {
  const matches = new Set<string>();
  for (const provider of catalogProviderEntries(raw)) {
    if (!apiMatchesBase(provider.entry, base)) continue;
    matches.add(provider.id);
    if (matches.size > 1) return undefined;
  }
  if (matches.size !== 1) return undefined;
  return [...matches][0];
}

function catalogProviderEntries(raw: unknown): CatalogProvider[] {
  const container =
    isRecord(raw) && Object.hasOwn(raw, "providers") ? raw.providers : raw;
  const providers: CatalogProvider[] = [];

  if (Array.isArray(container)) {
    for (const entry of container) {
      if (!isRecord(entry)) continue;
      const id =
        readString(entry.id) ?? readString(entry.provider_id) ?? readString(entry.slug);
      if (id !== undefined) providers.push({ id, entry });
    }
    return providers;
  }

  if (!isRecord(container)) return providers;
  for (const [id, entry] of Object.entries(container)) {
    if (id !== "" && isRecord(entry)) providers.push({ id, entry });
  }
  return providers;
}

function apiMatchesBase(provider: Record<string, unknown>, base: URL): boolean {
  const value = readString(provider.api);
  if (value === undefined) return false;

  let api: URL;
  try {
    api = new URL(value);
  } catch {
    return false;
  }
  if (api.protocol !== "http:" && api.protocol !== "https:") return false;
  if (api.username !== "" || api.password !== "") return false;
  if (api.origin !== base.origin) return false;

  return equivalentBasePaths(api.pathname, base.pathname);
}

function equivalentBasePaths(left: string, right: string): boolean {
  const a = pathSegments(left);
  const b = pathSegments(right);
  return sameBasePath(a, b) || sameBasePath(b, a);
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment !== "");
}

function sameBasePath(left: string[], right: string[]): boolean {
  if (left.length === right.length) {
    return left.every((segment, index) => segment === right[index]);
  }
  if (left.length !== right.length + 1) return false;
  if (!right.every((segment, index) => segment === left[index])) return false;

  const extra = left[left.length - 1];
  return extra !== undefined && VERSION_SEGMENT.test(extra);
}

function applyCatalog(models: Model[], raw: unknown, catalogProvider: string): void {
  const provider = findProvider(raw, catalogProvider);
  if (provider === undefined) return;
  const entries = providerModels(provider);
  if (entries === undefined) return;

  for (const model of models) {
    if (model.context !== undefined && model.output !== undefined) continue;
    const entry = findModel(entries, model.id);
    if (entry === undefined) continue;
    const limits = catalogLimits(entry);
    if (limits === undefined) continue;

    if (model.context === undefined && limits.context !== undefined) {
      model.context = { value: limits.context, source: "catalog" };
    }
    if (model.output === undefined && limits.output !== undefined) {
      model.output = { value: limits.output, source: "catalog" };
    }
  }
}

function findProvider(raw: unknown, providerId: string): unknown {
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      if (entry.id === providerId || entry.provider_id === providerId || entry.slug === providerId) {
        return entry;
      }
    }
    return undefined;
  }
  if (!isRecord(raw)) return undefined;

  if (Object.hasOwn(raw, providerId)) return raw[providerId];

  if (Object.hasOwn(raw, "providers")) {
    const providers = raw.providers;
    if (Array.isArray(providers)) return findProvider(providers, providerId);
    if (isRecord(providers) && Object.hasOwn(providers, providerId)) {
      return providers[providerId];
    }
  }
  return undefined;
}

function providerModels(provider: unknown): unknown {
  if (!isRecord(provider)) return undefined;
  return provider.models;
}

function findModel(entries: unknown, modelId: string): Record<string, unknown> | undefined {
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (entry.id === modelId || entry.model === modelId) return entry;
    }
    return undefined;
  }

  if (isRecord(entries) && Object.hasOwn(entries, modelId)) {
    const entry = entries[modelId];
    return isRecord(entry) ? entry : undefined;
  }
  return undefined;
}

function catalogLimits(entry: Record<string, unknown>): Limits | undefined {
  const limit = isRecord(entry.limit)
    ? entry.limit
    : isRecord(entry.limits)
      ? entry.limits
      : undefined;
  if (limit === undefined) return undefined;

  const context = positiveInteger(limit.context);
  const output = positiveInteger(limit.output);
  if (context === undefined && output === undefined) return undefined;
  return { context, output };
}

// ---------------------------------------------------------------------------
// Small parsing utilities
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function getPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}
