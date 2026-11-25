import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { Storage } from "../server/storage";
import {
  initialState,
  getBinding,
  mergeCatalog,
  resolvedModels,
  snapshotOf,
  type SavedConnection,
} from "../server/state";
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
  mergeCatalog(state, conn, [
    {
      id: "llm",
      label: "LLM",
      listed: true,
      context: { value: 4096, source: "gateway" },
    },
  ]);
  return { state, conn, binding };
}
test("opt-in selection, per-agent defaults, manual values and repeated refresh conflicts", () => {
  const { state, conn, binding } = fixture();
  assert.deepEqual(binding.selected, []);
  binding.selected = ["llm"];
  assert.throws(() => resolvedModels(state, binding), /缺少/);
  state.defaults.pi = { output: 256 };
  binding.overrides.llm = { context: { value: 2048, ack: 4096 } };
  assert.deepEqual(resolvedModels(state, binding), [
    { id: "llm", label: "LLM", context: 2048, output: 256 },
  ]);
  mergeCatalog(state, conn, [
    ...conn.models,
    { id: "other", label: "Other", listed: true },
  ]);
  assert.equal(binding.overrides.llm.context?.ack, 4096);
  assert.deepEqual(binding.selected, ["llm"]);
  mergeCatalog(state, conn, [
    {
      id: "llm",
      label: "LLM",
      listed: true,
      context: { value: 8192, source: "gateway" },
    },
  ]);
  assert.equal(binding.overrides.llm.context?.ack, undefined);
  assert.equal(binding.overrides.llm.context?.value, 2048);
  mergeCatalog(state, conn, []);
  assert.equal(conn.models[0].listed, false);
  assert.deepEqual(binding.selected, ["llm"]);
  assert.ok(!JSON.stringify(snapshotOf(state, [])).includes("test-secret"));
});
test("rejects a maximum output that is not smaller than the context window", () => {
  const { state, binding } = fixture();
  binding.selected = ["llm"];
  state.defaults.pi = { context: 4096, output: 4096 };
  assert.throws(() => resolvedModels(state, binding), /最大输出/);
  state.defaults.pi = { context: 4096, output: 2048 };
  assert.deepEqual(resolvedModels(state, binding), [
    { id: "llm", label: "LLM", context: 4096, output: 2048 },
  ]);
});
test("keeps known limits when a later gateway response omits them", () => {
  const { state, conn } = fixture();
  mergeCatalog(state, conn, [
    {
      id: "llm",
      label: "LLM",
      listed: true,
      context: { value: 8192, source: "gateway" },
      output: { value: 1024, source: "gateway" },
    },
  ]);
  mergeCatalog(state, conn, [{ id: "llm", label: "LLM", listed: true }]);
  assert.deepEqual(conn.models[0].context, { value: 8192, source: "gateway" });
  assert.deepEqual(conn.models[0].output, { value: 1024, source: "gateway" });
  mergeCatalog(state, conn, [
    {
      id: "llm",
      label: "LLM",
      listed: true,
      context: { value: 16384, source: "gateway" },
    },
  ]);
  assert.deepEqual(conn.models[0].context, { value: 16384, source: "gateway" });
  assert.deepEqual(conn.models[0].output, { value: 1024, source: "gateway" });
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
    assert.equal(
      JSON.parse(await readFile(join(root, "state.json"), "utf8")).version,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("an interrupted daemon commit is finalized on the next read", async () => {
  const { writeFile } = await import("node:fs/promises");
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
