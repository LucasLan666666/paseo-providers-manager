import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { Storage } from "../server/storage";
import {
  initialState,
  getBinding,
  mergeCatalog,
  migrateState,
  resolvedModels,
  snapshotOf,
  type SavedConnection,
} from "../server/state";
import { FALLBACK_LIMITS, naturalCompare, orderedSelection, resolveModel } from "../shared/limits";
import { randomUUID } from "node:crypto";

function fixture() {
  const state = initialState();
  const conn: SavedConnection = {
    id: randomUUID(),
    name: "Local",
    protocol: "chat",
    url: "http://localhost:9000/v1",
    key: "test-secret",
    hasKey: true,
    catalogProvider: "local",
    models: [],
    error: null,
    lastRefresh: null,
  };
  state.connections.push(conn);
  const binding = getBinding(state, "pi", conn.id);
  mergeCatalog(conn, [
    {
      id: "llm",
      label: "LLM",
      listed: true,
      context: { value: 4096, source: "gateway" },
    },
  ]);
  return { state, conn, binding };
}

test("limits resolve manual → gateway → catalog → connection fallback, shared by agents", () => {
  const { state, conn, binding } = fixture();
  binding.selected = ["llm"];
  // No output anywhere: the fallback applies, lowered below the 4096 window.
  assert.deepEqual(
    resolvedModels(state, binding).map(({ context, output, outputSource }) => ({ context, output, outputSource })),
    [{ context: 4096, output: 1024, outputSource: "fallback" }],
  );
  conn.settings = { llm: { context: { value: 2048, ack: 4096 }, output: { value: 512 } } };
  const [model] = resolvedModels(state, binding);
  assert.equal(model.context, 2048);
  assert.equal(model.output, 512);
  // Another agent on the same connection sees the same values.
  const omp = getBinding(state, "omp", conn.id);
  omp.selected = ["llm"];
  assert.equal(resolvedModels(state, omp)[0].context, 2048);
  // A changed automatic value clears the acknowledgement but keeps the manual value.
  mergeCatalog(conn, [{ id: "llm", label: "LLM", listed: true, context: { value: 8192, source: "gateway" } }]);
  assert.equal(conn.settings.llm.context?.ack, undefined);
  assert.equal(conn.settings.llm.context?.value, 2048);
  mergeCatalog(conn, []);
  assert.equal(conn.models[0].listed, false);
  assert.ok(!JSON.stringify(snapshotOf(state, [])).includes("test-secret"));
});

test("an unknown model uses the connection fallback, default 128K / 16K", () => {
  const { conn } = fixture();
  const unknown = { id: "x", label: "x", listed: true };
  const resolved = resolveModel(conn, unknown);
  assert.equal(resolved.context.value, FALLBACK_LIMITS.context);
  assert.equal(resolved.output.value, FALLBACK_LIMITS.output);
  assert.equal(resolved.context.source, "fallback");
  conn.fallback = { context: 64_000 };
  assert.equal(resolveModel(conn, unknown).context.value, 64_000);
  assert.equal(resolveModel(conn, unknown).output.value, FALLBACK_LIMITS.output);
});

test("only a manual output that fills the window is rejected", () => {
  const { state, conn, binding } = fixture();
  binding.selected = ["llm"];
  conn.models[0].output = { value: 9000, source: "gateway" };
  assert.equal(resolvedModels(state, binding)[0].output, 1024, "automatic output is clamped");
  conn.settings = { llm: { output: { value: 4096 } } };
  assert.throws(() => resolvedModels(state, binding), /最大输出 4096 必须小于上下文窗口 4096/);
});

test("capabilities come from the catalog and can be overridden per model", () => {
  const { state, conn, binding } = fixture();
  binding.selected = ["llm"];
  assert.deepEqual(resolvedModels(state, binding)[0].caps, { reasoning: false, image: false, tools: true });
  conn.models[0].caps = { reasoning: true, image: true };
  conn.settings = { llm: { image: false } };
  assert.deepEqual(resolvedModels(state, binding)[0].caps, { reasoning: true, image: false, tools: true });
});

test("the default model goes first, the rest sort by name; helpers never become the default", () => {
  const connection = {
    models: [
      { id: "codex-auto-review", label: "Codex Auto Review", listed: true },
      { id: "gpt-6.10", label: "gpt-6.10", listed: true },
      { id: "gpt-6.2", label: "gpt-6.2", listed: true },
      { id: "img", label: "img", listed: true, kind: "image" as const },
    ],
  };
  const selected = ["codex-auto-review", "img", "gpt-6.10", "gpt-6.2"];
  // Without an explicit default: the first selected chat model that isn't a helper.
  assert.deepEqual(orderedSelection({ selected }, connection), [
    "gpt-6.10",
    "codex-auto-review",
    "gpt-6.2",
    "img",
  ]);
  assert.deepEqual(orderedSelection({ selected, default: "gpt-6.2" }, connection), [
    "gpt-6.2",
    "codex-auto-review",
    "gpt-6.10",
    "img",
  ]);
  assert.ok(naturalCompare("gpt-6.2", "gpt-6.10") < 0);
});

test("new gateway models are flagged after the first catalog, never on it", () => {
  const { conn } = fixture();
  assert.equal(conn.models[0].fresh, undefined);
  mergeCatalog(conn, [...conn.models, { id: "new", label: "new", listed: true }]);
  assert.equal(conn.models.find((m) => m.id === "new")?.fresh, true);
  assert.equal(conn.models.find((m) => m.id === "llm")?.fresh, undefined);
});

test("version-1 state migrates: manual values move to the connection, agent defaults are dropped", () => {
  const id = randomUUID();
  const migrated = migrateState({
    version: 1,
    owner: "owner",
    defaults: { pi: { context: 1_000_000, output: 512_000 } },
    connections: [
      { id, name: "c", url: "https://x.test/v1", protocol: "chat", catalogProvider: "", hasKey: false, key: "", lastRefresh: null, error: null, models: [] },
    ],
    bindings: [
      { agent: "pi", connection: id, selected: ["m"], overrides: { m: { context: { value: 100 } } } },
      { agent: "omp", connection: id, selected: [], overrides: { m: { context: { value: 999 }, output: { value: 10 } } } },
    ],
  });
  assert.equal(migrated.version, 2);
  assert.ok(!("defaults" in migrated));
  assert.deepEqual(migrated.bindings, [
    { agent: "pi", connection: id, selected: ["m"] },
    { agent: "omp", connection: id, selected: [] },
  ]);
  assert.deepEqual(migrated.connections[0].settings, { m: { context: { value: 100 }, output: { value: 10 } } });
  assert.equal(migrated.connections[0].lastRefresh, null, "migrated connections refresh (and match) first");
});

test("migration drops a manual output that the v2 rules would reject", () => {
  const id = randomUUID();
  const migrated = migrateState({
    version: 1,
    owner: "owner",
    connections: [
      { id, name: "c", url: "https://x.test/v1", protocol: "responses", catalogProvider: "", hasKey: false, key: "", lastRefresh: null, error: null,
        models: [{ id: "m", label: "m", listed: true }, { id: "n", label: "n", listed: true }] },
    ],
    bindings: [
      // Valid in v1 for Codex (no order check) and relying on no context at all.
      { agent: "codex", connection: id, selected: ["m", "n"], overrides: { m: { output: { value: 128000 } }, n: { context: { value: 32000 }, output: { value: 1000 } } } },
    ],
  });
  assert.deepEqual(migrated.connections[0].settings, { n: { context: { value: 32000 }, output: { value: 1000 } } });
});

test("private state and rollback when daemon rejects alias changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-store-"));
  try {
    const store = new Storage(root);
    const api = {
      config: {
        get: async () => ({ config: { providers: {} } }),
        patch: async () => {
          throw new Error("failed");
        },
      },
    } as unknown as PaseoApi;
    const { state } = fixture();
    await store.commit(state, null, api);
    const next = structuredClone(state);
    next.connections[0].name = "Changed";
    await assert.rejects(
      store.commit(
        next,
        { providers: { alias: { env: { PPM_GENERATION: "new" } } } },
        api,
      ),
    );
    assert.equal((await store.load(api)).connections[0].name, "Local");
    assert.equal((await stat(join(root, "state.json"))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(root, "state.json"), "utf8")).version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loading a version-1 file migrates it and keeps a private backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-migrate-"));
  try {
    await writeFile(
      join(root, "state.json"),
      JSON.stringify({ version: 1, owner: "o", connections: [], bindings: [], defaults: {} }),
      { mode: 0o600 },
    );
    const api = { config: { get: async () => ({ config: { providers: {} } }) } } as unknown as PaseoApi;
    const loaded = await new Storage(root).load(api);
    assert.equal(loaded.version, 2);
    const backup = join(root, "state.v1.backup.json");
    assert.equal(JSON.parse(await readFile(backup, "utf8")).version, 1);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted daemon commit is finalized on the next read", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-recovery-"));
  const state = initialState();
  try {
    const patch = {
      providers: { alias: { env: { PPM_GENERATION: "test-generation" } } },
    };
    await writeFile(
      join(root, "transaction.json"),
      JSON.stringify({ next: state, patch }),
      { mode: 0o600 },
    );
    const api = {
      config: { get: async () => ({ config: patch }) },
    } as unknown as PaseoApi;
    const store = new Storage(root);
    assert.deepEqual(await store.load(api), state);
    assert.deepEqual(await store.load(api), state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
