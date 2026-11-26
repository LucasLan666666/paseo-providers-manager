import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One entry of Codex's model catalog (only the fields this plugin touches are typed). */
export interface CodexModelInfo {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  context_window?: number;
  max_context_window?: number;
  input_modalities?: string[];
  default_reasoning_level?: string | null;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  [key: string]: unknown;
}

const TTL_MS = 60 * 60 * 1000;
/** A failed read (Codex missing, slow start) is retried soon, not after an hour. */
const FAILURE_TTL_MS = 60 * 1000;
let cached: { at: number; models: CodexModelInfo[] | undefined } | undefined;

/**
 * The catalog shipped inside the installed Codex binary, read offline with
 * `codex debug models --bundled` from a throwaway CODEX_HOME. `model_catalog_json`
 * replaces this catalog entirely, so a generated catalog must start from it.
 * Returns undefined when Codex is missing or the command fails; callers then
 * write no catalog and Codex keeps its built-in values.
 */
export async function codexBundledCatalog(): Promise<CodexModelInfo[] | undefined> {
  // Tests must not depend on a locally installed Codex.
  if (process.env.PPM_DISABLE_CODEX_CATALOG) return undefined;
  if (cached && Date.now() - cached.at < (cached.models ? TTL_MS : FAILURE_TTL_MS)) return cached.models;
  const home = await mkdtemp(join(tmpdir(), "ppm-codex-catalog-"));
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "codex",
        ["debug", "models", "--bundled"],
        { env: { ...process.env, CODEX_HOME: home }, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
        (error, out) => (error ? reject(error) : resolve(out)),
      );
    });
    const parsed = JSON.parse(stdout) as { models?: unknown } | unknown[];
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.models) ? parsed.models : [];
    const models = list.filter(
      (entry): entry is CodexModelInfo =>
        typeof entry === "object" && entry !== null && typeof (entry as { slug?: unknown }).slug === "string",
    );
    cached = { at: Date.now(), models: models.length ? models : undefined };
  } catch {
    cached = { at: Date.now(), models: undefined };
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
  return cached.models;
}

/** For tests. */
export function resetCodexCatalogCache(): void {
  cached = undefined;
}
