import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { Jobs } from "./server/jobs";
import { Manager } from "./server/manager";
import {
  actionRpc,
  agentIds,
  jobRpc,
  snapshotRpc,
  nativeCatalogRpc,
} from "./shared/contracts";
import type { PaseoApi } from "./server/types";

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
  server.handle(jobRpc, ({ job }) => jobs.wait(job));
  server.handle(snapshotRpc, async (_input, { paseo }) => ({
    ...(await manager.snapshot(paseo)),
    icons: await agentIcons(paseo),
  }));
  server.handle(actionRpc, (action, { paseo }) =>
    jobs.start(manager.action(action, paseo)),
  );
  server.handle(nativeCatalogRpc, async ({ agent, cwd }, { paseo }) => {
    if (cwd && (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()))
      throw new Error("请输入现有项目的绝对路径。");
    const result = await paseo.providers.listModels(agent, { cwd });
    if (result.error)
      throw new Error(
        `原生目录不可用：${String(result.error).slice(0, 300)}`,
      );
    return (result.models ?? []).map(({ id, label }) => ({
      id,
      label: label || id,
    }));
  });
  return () => jobs.dispose();
}
