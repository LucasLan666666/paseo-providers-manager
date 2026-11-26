import { useRpc } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { jobRpc, type Operation } from "../shared/contracts";
import type { Lang } from "../shared/i18n";

export function useOperation() {
  const wait = useRpc(jobRpc);
  return useCallback(
    async (start: Promise<Operation>, lang: Lang) => {
      let result = await start;
      while (result.job) result = await wait({ job: result.job, lang });
      return result;
    },
    [wait],
  );
}
