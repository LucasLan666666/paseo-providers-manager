import { randomUUID } from "node:crypto";

type Report = { message: string; job?: string };
type Result = { value: { message: string } } | { error: string };

// Model discovery and a real agent turn can outlast Paseo's single RPC deadline.
export class Jobs {
  private jobs = new Map<string, { outcome: Promise<Result>; until: number }>();
  start(work: Promise<{ message: string }>): Promise<Report> {
    const now = Date.now();
    for (const [id, job] of this.jobs)
      if (job.until < now) this.jobs.delete(id);
    const id = randomUUID();
    const outcome = work.then(
      (value) => ({ value }),
      (error) => ({
        error: error instanceof Error ? error.message : "操作失败。",
      }),
    );
    this.jobs.set(id, { outcome, until: Infinity });
    void outcome.then(() => {
      const job = this.jobs.get(id);
      if (job) job.until = Date.now() + 600000;
    });
    return this.wait(id);
  }
  async wait(id: string): Promise<Report> {
    const job = this.jobs.get(id);
    if (!job) throw new Error("操作已结束或插件已重载，请刷新管理页。");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        job.outcome,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 4000);
        }),
      ]);
      if (!result) return { job: id, message: "处理中" };
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
