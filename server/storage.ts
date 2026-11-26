import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "./types";
import type { ProviderPatch } from "./types";
import { initialState, migrateState, type State } from "./state";
import { L } from "./i18n";

async function optionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(L("无法读取管理器数据，请检查数据文件及权限。", "Cannot read the manager data. Check the data file and its permissions."));
  }
}
async function atomicJson(path: string, value: unknown) {
  const temp = path + "." + randomUUID();
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
interface Pending {
  next: State;
  patch: ProviderPatch;
}

// The daemon applies one config patch atomically. If it accepted the patch but
// the process stopped before the rename, finish that commit on the next read.
export class Storage {
  constructor(readonly root: string) {}
  private get statePath() {
    return join(this.root, "state.json");
  }
  private get pendingPath() {
    return join(this.root, "transaction.json");
  }
  private async settle(pending: Pending, paseo: PaseoApi) {
    const { config } = await paseo.config.get();
    const intended = Object.entries(pending.patch.providers ?? {});
    const matches =
      intended.every(([id, entry]) => {
        const env = config.providers[id]?.env as
          | Record<string, string>
          | undefined;
        return (
          env?.PPM_GENERATION ===
          (entry.env as Record<string, string>).PPM_GENERATION
        );
      }) &&
      (pending.patch.removeProviders ?? []).every(
        (id) => !config.providers[id],
      );
    if (matches) await atomicJson(this.statePath, migrateState(pending.next));
    await rm(this.pendingPath, { force: true });
    return matches;
  }
  async load(paseo: PaseoApi) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const pending = await optionalJson<Pending>(this.pendingPath);
    if (pending) await this.settle(pending, paseo);
    const raw = await optionalJson<Parameters<typeof migrateState>[0]>(this.statePath);
    if (!raw) return initialState();
    if (raw.version !== 2) {
      // Keep the old file once so an older plugin build can be restored by hand.
      const backup = join(this.root, `state.v${raw.version}.backup.json`);
      await copyFile(this.statePath, backup)
        .then(() => chmod(backup, 0o600))
        .catch(() => {});
    }
    // The migrated state is written by the next committed action.
    return migrateState(raw);
  }
  async commit(
    next: State,
    patch: ProviderPatch | null,
    paseo: PaseoApi,
  ) {
    if (!patch) return atomicJson(this.statePath, next);
    const pending = { next, patch };
    await atomicJson(this.pendingPath, pending);
    try {
      await paseo.config.patch(patch);
    } catch {
      if (await this.settle(pending, paseo)) return;
      throw new Error(
        L("Paseo 未应用 provider 配置，请检查 CLI 版本和模型设置。", "Paseo did not apply the provider configuration. Check the CLI version and model settings."),
      );
    }
    await atomicJson(this.statePath, next);
    await rm(this.pendingPath, { force: true });
  }
}
