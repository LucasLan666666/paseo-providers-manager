import { useRpc } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { jobRpc, type Operation } from "../shared/contracts";

export function useOperation() {
  const wait = useRpc(jobRpc);
  return useCallback(
    async (start: Promise<Operation>) => {
      let result = await start;
      while (result.job) result = await wait({ job: result.job });
      return result;
    },
    [wait],
  );
}
