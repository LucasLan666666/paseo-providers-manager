import { readdir, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  antigravityPickerId,
  assertModels,
  assertProtocol,
  childDir,
  ensurePrivateDir,
  geminiBase,
  modelChoices,
  writePrivateJson,
  type AdapterConnection,
  type AdapterModel,
  type BuiltProvider,
} from "./adapter-common";

/**
 * agy 1.5.x reads its model provider from
 * ~/.gemini/antigravity-cli/settings.json and has no flag to relocate only that
 * file for `agy acp` (--settings is a top-level print-mode flag; --gemini-dir is
 * not a settings directory). Give it a private HOME containing symlinks to the
 * user's files, except .gemini, so git/ssh/etc. keep working while sessions,
 * logs and CLI settings stay inside the generation directory.
 *
 * ACP only lists agy's built-in, effort-qualified models. settings.json
 * customModelsConfig entries are visible to `agy models`, but ACP session/set_model
 * rejects them ("Unknown model ID"), so a custom Gemini gateway model must map
 * onto a built-in ID. We never silently map to a different model.
 */
export async function antigravityProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  dir: string,
): Promise<BuiltProvider> {
  assertProtocol("Antigravity", connection.protocol, ["gemini"]);
  assertModels(models);
  const pickers = models.map((model) => antigravityPickerId(model.id));
  const unsupported = models.filter((_, index) => pickers[index] === undefined);
  if (unsupported.length) {
    throw new Error(
      `Antigravity ACP 只能选择内置模型，网关模型 ${unsupported
        .map((model) => model.id)
        .join("、")} 未映射到 agy 内置的 gemini-4-neon / gemini-4-carbon / gemini-4-hydrogen / gemini-4-argon / gemini-3.8-flash / gemini-3.7-flash / gemini-3.6-flash / gemini-3.1-pro（可带 -low/-medium/-high/-xhigh）。`,
    );
  }

  const home = await ensurePrivateDir(childDir(dir, "home"));
  const gemini = await ensurePrivateDir(join(home, ".gemini"));
  const cli = await ensurePrivateDir(join(gemini, "antigravity-cli"));
  const realHome = homedir();
  for (const name of await readdir(realHome)) {
    if (name === ".gemini") continue;
    if (name === ".config") {
      // Keep agy's plugin-secret file inside the generation too.
      const realConfig = join(realHome, ".config");
      const privateConfig = await ensurePrivateDir(join(home, ".config"));
      let entries: string[] = [];
      try {
        entries = await readdir(realConfig);
      } catch {
        // No readable ~/.config: the isolated home simply starts without it.
      }
      for (const entry of entries) {
        if (entry === "antigravity") continue;
        try {
          await symlink(join(realConfig, entry), join(privateConfig, entry));
        } catch {
          // One user entry may be unavailable in the isolated home.
        }
      }
      continue;
    }
    try {
      await symlink(join(realHome, name), join(home, name));
    } catch {
      // A platform-specific entry may not be linkable. The CLI can still run;
      // only that one user file is unavailable inside the isolated home.
    }
  }

  const choices = modelChoices("antigravity", models);
  await writePrivateJson(join(cli, "settings.json"), {
    modelProvider: "gemini",
    model: choices[0].id,
    security: { auth: { selectedType: "gemini-api-key" } },
  });

  return {
    extends: "acp",
    command: ["agy", "acp", "--disable-telemetry"],
    env: {
      HOME: home,
      GEMINI_API_KEY: connection.key || "ppm-no-key",
      GOOGLE_GEMINI_BASE_URL: geminiBase(connection.url),
      GEMINI_MODEL: choices[0].id,
    },
    models: choices,
  };
}
