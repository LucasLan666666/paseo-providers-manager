import type { PaseoApi } from "./types";
import type { ProviderPatch } from "./types";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Binding } from "../shared/contracts";
import { buildProvider } from "./adapters";
import { GATEWAY_KEY_ENV, openAiBase } from "./adapter-common";
import { fxProvider } from "./fx";
import { agents } from "./agents";
import { findConnection, resolvedModels, type State } from "./state";

/** Unreferenced generation directories are kept briefly for running sessions. */
const GENERATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export const aliasFor = (binding: Pick<Binding, "agent" | "connection">) =>
  `ppm-${binding.agent}-${binding.connection}`;

const hashOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * `fingerprint` covers everything a generated config depends on, including the
 * base URL the adapters actually write (a host-root OpenAI URL becomes
 * `{host}/v1`). It is stored in the provider env as PPM_FINGERPRINT.
 * `legacy` is the fingerprint older versions computed from the stored URL; it is
 * only used for providers generated before PPM_FINGERPRINT existed.
 */
function plan(state: State) {
  const aliases = new Map<
    string,
    { binding: Binding; fingerprint: string; legacy: string }
  >();
  for (const binding of state.bindings) {
    if (!binding.selected.length) continue;
    const conn = findConnection(state, binding.connection);
    const agent = agents.find((item) => item.id === binding.agent)!;
    if (!agent.protocols.includes(conn.protocol))
      throw new Error(
        `${agent.label} 无法使用此网关协议，请先取消该连接上的模型选择。`,
      );
    const models = resolvedModels(state, binding);
    const base =
      conn.protocol === "chat" || conn.protocol === "responses"
        ? openAiBase(conn.url)
        : conn.url;
    aliases.set(aliasFor(binding), {
      binding,
      fingerprint: hashOf([conn.name, base, conn.protocol, conn.key, models]),
      legacy: hashOf([conn.name, conn.url, conn.protocol, conn.key, models]),
    });
  }
  return aliases;
}

export async function preparePatch(
  root: string,
  current: State,
  next: State,
  paseo: PaseoApi,
) {
  const previous = plan(current);
  const wanted = plan(next);
  const { config } = await paseo.config.get();
  const removeProviders = new Set(
    [...previous.keys()].filter((id) => !wanted.has(id)),
  );
  // A crash between applying a config patch and writing state can leave an
  // alias owned by this plugin with no binding. Remove those orphans on the
  // next action too, not only the aliases this action itself drops.
  for (const [id, entry] of Object.entries(config.providers ?? {})) {
    const env = entry?.env as Record<string, string> | undefined;
    if (env?.PPM_OWNER === next.owner && !wanted.has(id)) removeProviders.add(id);
  }
  // A provider config can disappear (or lose its generated directory) while the
  // plugin state still has the binding. Regenerate it instead of trusting the
  // fingerprint alone.
  const broken = new Set<string>();
  for (const [id] of wanted) {
    const entry = config.providers[id];
    if (!entry) {
      broken.add(id);
      continue;
    }
    const generation = (entry.env as Record<string, string> | undefined)
      ?.PPM_GENERATION;
    if (!generation) continue;
    try {
      await stat(generation);
    } catch {
      broken.add(id);
    }
  }
  // Compare against what is deployed, not against a fingerprint recomputed from
  // the committed state: a recomputation uses today's generator on both sides
  // and can never notice that a config was written by an older generator.
  const changed = [...wanted].filter(([id, value]) => {
    if (broken.has(id)) return true;
    const env = config.providers[id]?.env as Record<string, string> | undefined;
    const deployed = env?.PPM_FINGERPRINT || previous.get(id)?.legacy;
    return deployed !== value.fingerprint;
  });
  if (!removeProviders.size && !changed.length) return null;
  for (const alias of [
    ...removeProviders,
    ...changed.map(([id]) => id),
  ]) {
    const entry = config.providers[alias];
    const env = entry?.env as Record<string, string> | undefined;
    if (entry && env?.PPM_OWNER !== next.owner)
      throw new Error("同名 Paseo provider 已存在，无法覆盖其他配置。");
  }
  const providers: NonNullable<ProviderPatch["providers"]> = {};
  const dirs: string[] = [];
  try {
    for (const [id, { binding }] of changed) {
      const conn = findConnection(next, binding.connection);
      const models = resolvedModels(next, binding);
      const base = join(root, "generated", id);
      await mkdir(base, { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(join(base, "config-"));
      dirs.push(dir);
      if (binding.agent === "hoplite")
        throw new Error("Hoplite 仅提供云项目的原生模型。");
      const settings =
        binding.agent === "fx"
          ? await fxProvider(conn, models, dir)
          : await buildProvider(binding.agent, conn, models, dir);
      providers[id] = {
        ...settings,
        enabled: true,
        label: `${agents.find((a) => a.id === binding.agent)!.label} · ${conn.name}`,
        // Paseo deep-merges provider entries, so a removed key must be written as
        // an empty value instead of disappearing from the patch.
        env: {
          ...settings.env,
          [GATEWAY_KEY_ENV]: settings.env[GATEWAY_KEY_ENV] ?? "",
          PPM_OWNER: next.owner,
          PPM_GENERATION: dir,
          PPM_FINGERPRINT: wanted.get(id)!.fingerprint,
        },
      };
    }
  } catch (error) {
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    throw error;
  }
  return { providers, removeProviders: [...removeProviders] };
}

/**
 * Remove generated config directories no provider points at anymore. A provider
 * change leaves its old directory behind until every session started from it has
 * had time to finish, so keep recent ones even when unreferenced.
 */
export async function pruneGenerations(root: string, paseo: PaseoApi) {
  const { config } = await paseo.config.get();
  const referenced = new Set<string>();
  for (const provider of Object.values(config.providers ?? {})) {
    const env = provider?.env as Record<string, string> | undefined;
    if (env?.PPM_GENERATION) referenced.add(env.PPM_GENERATION);
  }
  const generated = join(root, "generated");
  let aliases: string[];
  try {
    aliases = await readdir(generated);
  } catch {
    return;
  }
  const cutoff = Date.now() - GENERATION_GRACE_MS;
  for (const alias of aliases) {
    const directory = join(generated, alias);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    let kept = 0;
    for (const entry of entries) {
      const target = join(directory, entry);
      if (referenced.has(target)) {
        kept += 1;
        continue;
      }
      try {
        if ((await stat(target)).mtimeMs < cutoff)
          await rm(target, { recursive: true, force: true });
        else kept += 1;
      } catch {
        kept += 1;
      }
    }
    if (kept === 0) await rm(directory, { recursive: true, force: true });
  }
}
