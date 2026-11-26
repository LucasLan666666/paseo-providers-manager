import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProvider } from "../server/adapters";
import { codexCatalog } from "../server/adapter-codex";
import type { CodexModelInfo } from "../server/codex-catalog";
import {
  anthropicBase,
  antigravityPickerId,
  assertModels,
  endpoint,
  geminiBase,
  modelChoices,
  openAiBase,
  pickerModelId,
  requireLimits,
  type AdapterConnection,
} from "../server/adapter-common";

const models = [
  { id: "model-a", label: "Model A", context: 64000, output: 4096 },
];
const connection = (protocol: AdapterConnection["protocol"]): AdapterConnection => ({
  id: "connection",
  name: "Fixture",
  url: "https://gateway.test/v1",
  protocol,
  key: "test-key",
});

test("normalizes native gateway bases without inventing a version", () => {
  assert.equal(endpoint("https://gateway.test/v1/"), "https://gateway.test/v1");
  assert.equal(anthropicBase("https://gateway.test/v1"), "https://gateway.test");
  assert.equal(anthropicBase("https://gateway.test/api/v1"), "https://gateway.test/api");
  assert.equal(geminiBase("https://gateway.test/v1beta"), "https://gateway.test");
  assert.equal(geminiBase("https://gateway.test/api/v1beta"), "https://gateway.test/api");
  assert.throws(() => endpoint("ftp://gateway.test"), /HTTP/);
  assert.throws(() => endpoint("https://user:pass@gateway.test"), /用户名|密码/);
  assert.throws(() => endpoint("https://gateway.test/v1?key=secret"), /查询参数/);
});

test("OpenAI bases are used exactly as entered", async () => {
  assert.equal(openAiBase("https://gateway.test"), "https://gateway.test");
  assert.equal(openAiBase("https://gateway.test/v1/"), "https://gateway.test/v1");
  const root = await mkdtemp(join(tmpdir(), "ppm-adapters-"));
  try {
    const codex = await buildProvider(
      "codex",
      { ...connection("responses"), url: "https://gateway.test" },
      models,
      join(root, "codex"),
    );
    const toml = await readFile(join(codex.env.CODEX_HOME, "config.toml"), "utf8");
    assert.match(toml, /base_url = "https:\/\/gateway\.test"/);
    await assert.rejects(
      buildProvider("codex", connection("chat"), models, join(root, "codex-chat")),
      /OpenAI Chat Completions 协议；可用协议：OpenAI Responses/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maps Antigravity gateway ids onto the agy ACP built-ins", () => {
  assert.equal(antigravityPickerId("gemini-4-argon"), "gemini-4-argon-high");
  assert.equal(antigravityPickerId("models/gemini-4-neon"), "gemini-4-neon-high");
  assert.equal(antigravityPickerId("gemini-4-argon-medium"), "gemini-4-argon-medium");
  assert.equal(antigravityPickerId("gemini-3.1-pro-medium"), undefined);
  assert.equal(antigravityPickerId("gemini-2.5-flash"), undefined);
  assert.equal(pickerModelId("pi", "model-a"), "ppm/model-a");
  assert.equal(pickerModelId("opencode", "model-a"), "ppm/model-a");
  assert.equal(pickerModelId("copilot", "model-a"), "ppm/model-a");
  assert.equal(pickerModelId("omp", "model-a"), "ppm/model-a");
  assert.equal(pickerModelId("claude", "model-a"), "model-a");
});

test("rejects duplicate picker ids and missing required limits", () => {
  assert.throws(
    () =>
      modelChoices("antigravity", [
        { id: "gemini-4-argon", label: "A" },
        { id: "gemini-4-argon-high", label: "B" },
      ]),
    /重复/,
  );
  assert.throws(
    () => requireLimits("Pi", [{ id: "x", label: "X", context: 1000 }]),
    /最大输出/,
  );
  assert.throws(() => assertModels([{ id: "bad\nid", label: "Bad" }]), /控制字符/);
});

test("writes native configs and per-model limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-adapters-"));
  try {
    const claude = await buildProvider(
      "claude",
      { ...connection("anthropic"), url: "https://gateway.test/v1" },
      models,
      join(root, "claude"),
    );
    assert.equal(claude.extends, "claude");
    assert.equal(claude.env.ANTHROPIC_BASE_URL, "https://gateway.test");
    assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, "test-key");
    assert.deepEqual(claude.models.map((m) => m.id), ["model-a"]);

    const codex = await buildProvider(
      "codex",
      connection("responses"),
      models,
      join(root, "codex"),
    );
    assert.equal(codex.extends, "codex");
    const codexToml = await readFile(
      join(codex.env.CODEX_HOME, "config.toml"),
      "utf8",
    );
    assert.match(codexToml, /wire_api = "responses"/);
    assert.match(codexToml, /base_url = "https:\/\/gateway.test\/v1"/);
    assert.match(codexToml, /env_key = "PPM_GATEWAY_KEY"/);

    const copilot = await buildProvider(
      "copilot",
      connection("chat"),
      models,
      join(root, "copilot"),
    );
    assert.equal(copilot.extends, "copilot");
    const registry = JSON.parse(
      await readFile(join(copilot.env.COPILOT_HOME, "providers.json"), "utf8"),
    );
    assert.deepEqual(registry.providers[0], {
      name: "ppm",
      type: "openai",
      baseUrl: "https://gateway.test/v1",
      wireApi: "completions",
      bearerToken: "test-key",
    });
    assert.equal(registry.models[0].maxContextWindowTokens, 64000);
    assert.equal(registry.models[0].maxOutputTokens, 4096);
    assert.equal(registry.models[0].maxPromptTokens, 59904);

    const opencode = await buildProvider(
      "opencode",
      connection("chat"),
      models,
      join(root, "opencode"),
    );
    const opencodeConfig = JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(opencodeConfig.model, "ppm/model-a");
    assert.deepEqual(opencodeConfig.provider.ppm.models["model-a"].limit, {
      context: 64000,
      output: 4096,
    });

    const pi = await buildProvider("pi", connection("chat"), models, join(root, "pi"));
    const piModels = JSON.parse(
      await readFile(join(pi.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"),
    );
    assert.equal(piModels.providers.ppm.apiKey, "$PPM_GATEWAY_KEY");
    assert.equal(piModels.providers.ppm.models[0].contextWindow, 64000);
    assert.equal(piModels.providers.ppm.models[0].maxTokens, 4096);
    assert.equal(pi.env.PPM_GATEWAY_KEY, "test-key");

    const omp = await buildProvider("omp", connection("chat"), models, join(root, "omp"));
    const ompModels = JSON.parse(
      await readFile(join(omp.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"),
    );
    assert.equal(ompModels.providers.ppm.apiKey, "test-key");
    assert.equal(omp.env.PPM_GATEWAY_KEY, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported agents fail instead of falling through to another endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-adapters-muse-"));
  try {
    await assert.rejects(
      buildProvider("muse", connection("chat"), models, join(root, "muse")),
      /没有可验证/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const bundled: CodexModelInfo[] = [
  { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", context_window: 272000, max_context_window: 872000, input_modalities: ["text", "image"], base_instructions: "luna" },
  { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", context_window: 272000, max_context_window: 272000, base_instructions: "5.5" },
];

test("Codex catalog keeps built-in models and only adds unknown or manually changed ones", () => {
  const caps = { reasoning: true, image: false, tools: true };
  assert.equal(
    codexCatalog([{ id: "gpt-6-luna", label: "Luna", context: 1050000, contextSource: "catalog", caps }], bundled),
    undefined,
    "a known model without a manual value keeps Codex's own window",
  );
  assert.equal(codexCatalog([{ id: "x", label: "x", context: 1000, caps }], undefined), undefined);
  const catalog = codexCatalog(
    [
      { id: "gpt-5.5", label: "GPT-5.5", context: 200000, contextSource: "manual", caps },
      { id: "gpt-5.5-openai-compact", label: "compact", context: 272000, contextSource: "catalog", caps },
      { id: "gpt-image-2", label: "img", context: 1, chat: false },
    ],
    bundled,
  )!;
  assert.deepEqual(catalog.map((entry) => entry.slug), ["gpt-6-luna", "gpt-5.5", "gpt-5.5-openai-compact"]);
  assert.equal(catalog[0], bundled[0], "untouched entries are copied as-is");
  assert.equal(catalog[1].context_window, 200000);
  assert.equal(catalog[1].max_context_window, 272000);
  assert.equal(catalog[2].base_instructions, "5.5", "an unknown model clones its family parent");
  assert.equal(catalog[2].context_window, 272000);
  assert.deepEqual(catalog[2].input_modalities, ["text"]);
});

test("Codex writes model_catalog_json only when the catalog changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-adapters-"));
  try {
    const plain = await buildProvider("codex", connection("responses"), [{ id: "gpt-6-luna", label: "L", context: 272000 }], join(root, "a"), { codexCatalog: bundled });
    assert.doesNotMatch(await readFile(join(plain.env.CODEX_HOME, "config.toml"), "utf8"), /model_catalog_json/);
    const unrelated = await buildProvider("codex", connection("responses"), [{ id: "relay-only", label: "R", context: 64000 }], join(root, "u"), { codexCatalog: bundled });
    assert.doesNotMatch(
      await readFile(join(unrelated.env.CODEX_HOME, "config.toml"), "utf8"),
      /model_catalog_json/,
      "a model without a family member in Codex's catalog is left to Codex",
    );
    const custom = await buildProvider("codex", connection("responses"), [{ id: "gpt-5.5-openai-compact", label: "C", context: 64000 }], join(root, "b"), { codexCatalog: bundled });
    const toml = await readFile(join(custom.env.CODEX_HOME, "config.toml"), "utf8");
    assert.match(toml, /model_catalog_json = ".*models\.json"/);
    const written = JSON.parse(await readFile(join(custom.env.CODEX_HOME, "models.json"), "utf8"));
    assert.deepEqual(written.models.map((entry: CodexModelInfo) => entry.slug), ["gpt-6-luna", "gpt-5.5", "gpt-5.5-openai-compact"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Code only receives limits for models it doesn't know or manual outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-adapters-"));
  try {
    const anthropic = { ...connection("anthropic"), url: "https://gateway.test" };
    const known = await buildProvider("claude", anthropic, [{ id: "claude-opus-5-5", label: "Opus", context: 1000000, output: 128000, outputSource: "catalog" }], join(root, "a"));
    assert.equal(known.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "");
    assert.equal(known.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "");
    const mixed = await buildProvider(
      "claude",
      anthropic,
      [
        { id: "claude-opus-5-5", label: "Opus", context: 1000000, output: 64000, outputSource: "manual" },
        { id: "glm-4.7", label: "GLM", context: 204800, output: 131072, outputSource: "catalog" },
      ],
      join(root, "b"),
    );
    assert.equal(mixed.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "204800");
    assert.equal(mixed.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
