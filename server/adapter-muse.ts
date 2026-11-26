import type { AdapterConnection, AdapterModel, BuiltProvider } from "./adapter-common";
import { L } from "./i18n";

/**
 * Muse Code talks to Meta's MSP host through `muse serve`; its provider plugin
 * exposes account/model discovery but no documented custom inference base URL
 * or API-key route. Returning a made-up endpoint would silently send traffic to
 * Meta's service, so a custom gateway is refused.
 */
export async function museProvider(
  _connection: AdapterConnection,
  _models: readonly AdapterModel[],
  _dir: string,
): Promise<BuiltProvider> {
  throw new Error(
    L(
      "Muse Code 目前没有可验证的自定义推理网关接口，只能使用其登录和模型目录。",
      "Muse Code has no verifiable custom inference gateway; only its own login and model list can be used.",
    ),
  );
}
