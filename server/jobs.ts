import { randomUUID } from "node:crypto";
import type { Operation } from "../shared/contracts";
import { L } from "./i18n";

type Outcome = Omit<Operation, "job">;
type Result = { value: Outcome } | { error: string };

// Model discovery and a real agent turn can outlast Paseo's single RPC deadline.
export class Jobs {
  private jobs = new Map<string, { outcome: Promise<Result>; until: number }>();
  start(work: Promise<Outcome>): Promise<Operation> {
    const now = Date.now();
    for (const [id, job] of this.jobs)
      if (job.until < now) this.jobs.delete(id);
    const id = randomUUID();
    const outcome = work.then(
      (value) => ({ value }),
      (error) => ({
        error: error instanceof Error ? error.message : L("操作失败。", "The operation failed."),
      }),
    );
    this.jobs.set(id, { outcome, until: Infinity });
    void outcome.then(() => {
      const job = this.jobs.get(id);
      if (job) job.until = Date.now() + 600000;
    });
    return this.wait(id);
  }
  async wait(id: string): Promise<Operation> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(
        L("操作已结束或插件已重载，请刷新管理页。", "The operation has ended or the plugin was reloaded. Refresh the page."),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        job.outcome,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 4000);
        }),
      ]);
      if (!result) return { job: id, message: L("处理中", "Working") };
      if ("error" in result) throw new Error(result.error);
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }
  dispose() {
    this.jobs.clear();
  }
}
