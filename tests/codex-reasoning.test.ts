import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";
import { buildProvider } from "../server/adapters";
import { initialState, resolvedModels } from "../server/state";
import { connectionSchema } from "../shared/contracts";
import type { CodexModelInfo } from "../server/codex-catalog";

const connection = { id: "fixture", name: "Fixture", protocol: "responses" as const, url: "https://gateway.test/v1", key: "" };
const bundled: CodexModelInfo[] = [
  {
    slug: "gpt-5.5",
    context_window: 272000,
    max_context_window: 1050000,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Lighter reasoning" },
      { effort: "medium" },
      { effort: "high" },
      { effort: "xhigh" },
      { effort: "ultra" },
    ],
  },
  {
    slug: "gpt-6-luna",
    default_reasoning_level: "max",
    supported_reasoning_levels: [{ effort: "medium" }, { effort: "max" }],
  },
  {
    slug: "gpt-5.6-sol",
    default_reasoning_level: "ultra",
    supported_reasoning_levels: [{ effort: "high" }, { effort: "ultra" }],
  },
];

test("Codex provider publishes catalog reasoning options and keeps context overrides", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ppm-codex-reasoning-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = await buildProvider("codex", connection, [
    { id: "gpt-5.5", label: "GPT-5.5", context: 64000, contextSource: "manual" },
    { id: "gpt-5.5-openai-compact", label: " Compact ", context: 32000,
      codexReasoning: { model: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] } },
    { id: "gpt-5.6-sol-openai-compact", label: "Sol Compact", codexReasoning: { model: "gpt-5.6-sol" } },
    { id: "gpt-6-luna", label: "Luna" },
    { id: "gpt-6", label: "Family alias", context: 128000 },
    { id: "gpt-5.5-other", label: "Other alias" },
    { id: "relay-only", label: "Relay model" },
  ], dir, { codexCatalog: bundled });
  const choices = ProviderOverrideSchema.parse(provider).models!;
  const [exact, compact, solCompact, luna, ...unknown] = choices;
  assert.equal(exact.isDefault, true);
  assert.deepEqual(exact.thinkingOptions, [
    { id: "low", label: "low", description: "Lighter reasoning" },
    { id: "medium", label: "medium", isDefault: true },
    { id: "high", label: "high" },
    { id: "xhigh", label: "xhigh" },
    { id: "ultra", label: "ultra" },
  ]);
  assert.equal(compact.id, "gpt-5.5-openai-compact");
  assert.equal(compact.label, "Compact");
  assert.deepEqual(compact.thinkingOptions, exact.thinkingOptions?.slice(0, 4));
  assert.deepEqual(solCompact.thinkingOptions?.map(({ id }) => id), ["high", "ultra"]);
  assert.deepEqual(luna.thinkingOptions?.map(({ id }) => id), ["medium", "max"]);
  assert.deepEqual(unknown.map(({ thinkingOptions }) => thinkingOptions), [[], undefined, undefined]);

  const override = provider.command?.find((arg) => arg.startsWith("model_catalog_json="));
  assert.ok(override);
  const path = JSON.parse(override.slice("model_catalog_json=".length)) as string;
  const { models } = JSON.parse(await readFile(path, "utf8")) as { models: CodexModelInfo[] };
  assert.equal(models.find(({ slug }) => slug === "gpt-5.5")?.context_window, 64000);
  assert.equal(models.find(({ slug }) => slug === "gpt-5.5")?.max_context_window, 1050000);
  assert.equal(models.find(({ slug }) => slug === "gpt-5.5-openai-compact")?.context_window, 32000);
  const inferred = models.find(({ slug }) => slug === "gpt-6");
  assert.equal(inferred?.context_window, 128000);
  assert.deepEqual(inferred?.supported_reasoning_levels, []);
  assert.equal(inferred?.default_reasoning_level, null);
  const alias = models.find(({ slug }) => slug === compact.id);
  assert.deepEqual(alias?.supported_reasoning_levels?.map(({ effort }) => effort), compact.thinkingOptions?.map(({ id }) => id));
  assert.equal(alias?.default_reasoning_level, compact.thinkingOptions?.find(({ isDefault }) => isDefault)?.id);
});

test("a bundled exact alias entry wins and an unavailable catalog yields plain choices", async () => {
  const model = { id: "gpt-5.5-openai-compact", label: "Compact" };
  const models = [{ ...model, codexReasoning: { model: "gpt-5.5" } }];
  const provider = await buildProvider("codex", connection, models, ".", {
    codexCatalog: [...bundled, {
      slug: models[0].id,
      default_reasoning_level: "ultra",
      supported_reasoning_levels: [{ effort: "ultra" }],
    }],
  });
  assert.deepEqual(provider.models[0].thinkingOptions, [{ id: "ultra", label: "ultra", isDefault: true }]);
  assert.deepEqual((await buildProvider("codex", connection, models, ".")).models, [
    { ...model, isDefault: true },
  ]);
});

test("connection settings isolate alias mappings and preserve an explicit reasoning shutdown", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ppm-codex-connections-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = initialState();
  const alias = "relay-alias";
  for (const [offset, settings] of [
    { [alias]: { codexReasoning: { model: "gpt-5.5", efforts: ["high", "unsupported"] } } },
    { [alias]: { codexReasoning: { model: "gpt-6-luna" }, reasoning: false } },
  ].entries()) {
    const id = `00000000-0000-4000-8000-00000000000${offset}`;
    const saved = connectionSchema.parse({
      ...connection,
      id,
      hasKey: false,
      catalogProvider: "",
      lastRefresh: null,
      error: null,
      settings,
      models: [{ id: alias, label: alias, listed: true }, { id: "gpt-6-luna", label: "Luna", listed: true }],
    });
    state.connections.push({ ...saved, key: "" });
    state.bindings.push({ agent: "codex", connection: id, selected: [alias, "gpt-6-luna"] });
  }
  for (const [offset, binding] of state.bindings.entries()) {
    const models = resolvedModels(state, binding);
    assert.equal(models[0].caps.reasoning, false);
    assert.equal(models[0].reasoningOverride, offset ? false : undefined);
    const provider = await buildProvider("codex", connection, models, join(dir, String(offset)), { codexCatalog: bundled });
    assert.deepEqual(provider.models[0].thinkingOptions, offset ? [] : [{ id: "high", label: "high", isDefault: true }]);
    assert.deepEqual(provider.models[1].thinkingOptions?.map(({ id }) => id), ["medium", "max"]);
    const catalogPath = join(dir, String(offset), "codex", "models.json");
    const { models: catalog } = JSON.parse(await readFile(catalogPath, "utf8")) as { models: CodexModelInfo[] };
    const effective = catalog.find(({ slug }) => slug === alias);
    assert.deepEqual(effective?.supported_reasoning_levels, offset ? [] : [{ effort: "high" }]);
    assert.equal(effective?.default_reasoning_level, offset ? null : "high");
  }
});
