import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];
export type ProviderPatch = Parameters<PaseoApi["config"]["patch"]>[0];
