import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { Jobs } from "./server/jobs";
import { Manager } from "./server/manager";
import {
  actionRpc,
  jobRpc,
  snapshotRpc,
  nativeCatalogRpc,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const manager = new Manager(
    join(home, "plugin-data", "paseo-providers-manager"),
  );
  const jobs = new Jobs();
  server.handle(jobRpc, ({ job }) => jobs.wait(job));
  server.handle(snapshotRpc, (_input, { paseo }) => manager.snapshot(paseo));
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
