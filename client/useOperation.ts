import { useRpc } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { jobRpc } from "../shared/contracts";

type Report = {message:string;job?:string};
export function useOperation() {
  const wait = useRpc(jobRpc);
  return useCallback(async(start:Promise<Report>)=>{
    let result=await start;
    while (result.job) result=await wait({job:result.job});
    return result;
  },[wait]);
}
