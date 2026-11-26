import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { Jobs } from "./server/jobs";
import { Manager } from "./server/manager";
import {
  actionRpc,
  agentIds,
  jobRpc,
  snapshotRpc,
  nativeCatalogRpc,
  type Action,
  type AgentId,
} from "./shared/contracts";
import type { PaseoApi } from "./server/types";
import { L, withLang } from "./server/i18n";

const ICON_TTL_MS = 10 * 60 * 1000;
const ICON_WAIT_MS = 1500;
/** Must stay within the snapshot contract (z.string().max(65536)). */
const ICON_MAX_CHARS = 60_000;
let iconCache: { at: number; icons: Record<string, string> } | undefined;
let iconRequest: Promise<Record<string, string>> | undefined;

/**
 * The icons Paseo shows for agents it learned from plugins (e.g. Muse). Built-in
 * agents have no SVG in the snapshot; the client ships Paseo's icons for those.
 */
async function loadIcons(paseo: PaseoApi): Promise<Record<string, string>> {
  const icons: Record<string, string> = {};
  try {
    const { entries } = await paseo.providers.snapshot();
    for (const entry of entries ?? []) {
      const svg = entry.iconSvg;
      if (
        (agentIds as readonly string[]).includes(entry.provider) &&
        typeof svg === "string" &&
        svg.length <= ICON_MAX_CHARS
      )
        icons[entry.provider] = svg;
    }
  } catch {
    // Icons are cosmetic; the client falls back to its own.
  }
  iconCache = { at: Date.now(), icons };
  return icons;
}

/** Never makes the snapshot wait long: a slow provider snapshot fills the cache later. */
async function agentIcons(paseo: PaseoApi): Promise<Record<string, string>> {
  if (iconCache && Date.now() - iconCache.at < ICON_TTL_MS) return iconCache.icons;
  iconRequest ??= loadIcons(paseo).finally(() => {
    iconRequest = undefined;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ICON_WAIT_MS);
  });
  const icons = await Promise.race([iconRequest, timeout]);
  clearTimeout(timer);
  return icons ?? iconCache?.icons ?? {};
}

export default function contribute(server: PluginServerContext) {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const manager = new Manager(
    join(home, "plugin-data", "paseo-providers-manager"),
  );
  const jobs = new Jobs();
  server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    if (!request.provider.startsWith("ppm-opencode-")) return;
    const { config } = await paseo.config.get();
    const profile = config.providers[request.provider];
    const env = profile?.env as Record<string, string> | undefined;
    if (profile?.extends !== "opencode" || !env?.PPM_OWNER) return;
    if (env.PPM_OPENCODE_CONFIG) {
      return {
        ...request,
        env: {
          ...request.env,
          OPENCODE_CONFIG_CONTENT: await readFile(env.PPM_OPENCODE_CONFIG, "utf8"),
        },
      };
    }
    // Connections created before the private-file migration can open immediately.
    if (env.OPENCODE_CONFIG_CONTENT) {
      return {
        ...request,
        env: {
          ...request.env,
          OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT,
          PPM_GATEWAY_KEY: env.PPM_GATEWAY_KEY || "ppm-no-key",
        },
      };
    }
    throw new Error(L("缺少 OpenCode 连接配置。", "Missing OpenCode connection configuration."));
  });
  // Every handler runs in the language the client asked for (server/i18n.ts).
  server.handle(jobRpc, ({ job, lang }) => withLang(lang, () => jobs.wait(job)));
  server.handle(snapshotRpc, ({ lang }, { paseo }) =>
    withLang(lang, async () => ({
      ...(await manager.snapshot(paseo)),
      icons: await agentIcons(paseo),
    })),
  );
  server.handle(actionRpc, ({ lang, ...action }, { paseo }) =>
    withLang(lang, () => jobs.start(manager.action(action as Action, paseo))),
  );
  server.handle(nativeCatalogRpc, ({ agent, cwd, lang }, { paseo }) =>
    withLang(lang, () => nativeModels(agent, cwd, paseo)),
  );
  return () => jobs.dispose();
}

async function nativeModels(agent: AgentId, cwd: string | undefined, paseo: PaseoApi) {
  // stat() rejects with Node's English ENOENT for a missing path; report it plainly.
  const isDirectory = cwd
    ? await stat(cwd).then((info) => info.isDirectory(), () => false)
    : true;
  if (cwd && (!isAbsolute(cwd) || !isDirectory))
    throw new Error(L("请输入现有项目的绝对路径。", "Enter the absolute path of an existing project."));
  const result = await paseo.providers.listModels(agent, { cwd });
  if (result.error)
    throw new Error(
      L("原生目录不可用：", "The native model list is unavailable: ") + String(result.error).slice(0, 300),
    );
  return (result.models ?? []).map(({ id, label }) => ({
    id,
    label: label || id,
  }));
}
