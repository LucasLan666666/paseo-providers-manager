import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Socket } from "node:net";
import type { PaseoApi } from "@getpaseo/client";
import { Manager } from "../server/manager";

// No test in this file may reach the internet (models.dev enrichment runs on
// every refresh). Individual tests can fake models.dev through gateway().
const nativeFetch = globalThis.fetch;
before(() => {
  process.env.PPM_DISABLE_CODEX_CATALOG = "1";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(input, init);
    throw new Error(`blocked external request to ${url.hostname}`);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = nativeFetch;
});

test("catalog refresh, opt-in selection, shared bindings, conflicts, delisting and connection deletion", async () => {
  let rows: unknown[] = [
    { id: "model", context_length: 65536, max_output_tokens: 8192 },
  ];
  let fail = false;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-key");
    res.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: rows }));
  });
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "ppm-manager-"));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const providers: Record<string, unknown> = {
    "external-entry": { enabled: true },
  };
  const api = {
    config: {
      get: async () => ({ config: { providers } }),
      patch: async (patch: {
        providers: Record<string, unknown>;
        removeProviders: string[];
      }) => {
        Object.assign(providers, patch.providers);
        for (const key of patch.removeProviders) delete providers[key];
      },
    },
  } as unknown as PaseoApi;
  const m = new Manager(root);
  try {
    await m.action(
      {
        type: "saveConnection",
        name: "Local",
        url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "chat",
        key: "test-key",
        catalogProvider: "",
      },
      api,
    );
    const first = await m.snapshot(api);
    assert.equal(first.connections.length, 1);
    assert.deepEqual(first.bindings, []);
    const connection = first.connections[0].id;
    const params = { agent: "fx" as const, connection };
    await m.action(
      {
        type: "selection",
        ...params,
        selected: ["model"],
        changes: [{ model: "model", field: "context", value: 48000 }],
      },
      api,
    );
    assert.ok(providers["ppm-fx-" + connection]);
    // A provider entry can be lost while the binding survives; the next save
    // must regenerate it instead of assuming the fingerprint is still present.
    delete providers["ppm-fx-" + connection];
    await m.action(
      { type: "selection", ...params, selected: ["model"] },
      api,
    );
    assert.ok(providers["ppm-fx-" + connection]);
    const tested = await m.action(
      { type: "testConnection", connection },
      api,
    );
    assert.match(tested.message, /全部通过/);
    // An alias owned by this plugin can outlive its binding after a crash between
    // the config commit and the state write; the next action prunes it.
    const owner = JSON.parse(await readFile(join(root, "state.json"), "utf8")).owner;
    providers["orphan-alias"] = {
      enabled: true,
      env: { PPM_OWNER: owner, PPM_GENERATION: join(root, "orphan") },
    };
    await m.action({ type: "fallback", connection, output: 512 }, api);
    assert.ok(!("orphan-alias" in providers));
    rows = [
      { id: "model", context_length: 131072, max_output_tokens: 8192 },
      { id: "new", context_length: 4096, max_output_tokens: 512 },
    ];
    await m.action({ type: "refresh", connection }, api);
    const refreshed = await m.snapshot(api);
    assert.deepEqual(refreshed.bindings[0].selected, ["model"]);
    // Manual values live on the connection; the changed automatic value cleared the ack.
    assert.deepEqual(refreshed.connections[0].settings?.model?.context, {
      value: 48000,
    });
    await m.action(
      {
        type: "settings",
        connection,
        changes: [{ model: "model", field: "context", value: 48000 }],
      },
      api,
    );
    await m.action({ type: "refresh", connection }, api);
    assert.equal(
      (await m.snapshot(api)).connections[0].settings?.model?.context?.ack,
      131072,
    );
    fail = true;
    await assert.rejects(m.action({ type: "refresh", connection }, api));
    assert.deepEqual(
      (await m.snapshot(api)).connections[0].models,
      refreshed.connections[0].models,
    );
    fail = false;
    rows = [];
    await m.action({ type: "refresh", connection }, api);
    const last = await m.snapshot(api);
    assert.deepEqual(last.bindings[0].selected, ["model"]);
    assert.equal(last.connections[0].models[0].listed, false);
    await m.action({ type: "deleteConnection", connection }, api);
    assert.deepEqual(Object.keys(providers), ["external-entry"]);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface GatewayOptions {
  /** Served as https://models.dev/api.json; otherwise external requests fail. */
  catalog?: unknown;
  /** Answers POST requests (real-request tests). */
  post?: (path: string, body: { model?: string }, auth: string | undefined) => { status: number; body: unknown };
}

async function gateway(rows: () => unknown[], options: GatewayOptions = {}) {
  // Keep these tests offline: external hosts are blocked, models.dev can be faked.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
    if (url.hostname === "models.dev" && options.catalog !== undefined)
      return new Response(JSON.stringify(options.catalog), { headers: { "content-type": "application/json" } });
    throw new Error(`blocked external request to ${url.hostname}`);
  }) as typeof fetch;
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (req.method === "POST" && options.post) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const reply = options.post!(req.url ?? "", JSON.parse(raw || "{}"), auth);
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
      return;
    }
    const ok = auth === "Bearer test-key";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { data: rows() } : { error: "unauthorized" }));
  });
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const providers: Record<string, unknown> = {};
  const api = {
    config: {
      get: async () => ({ config: { providers } }),
      patch: async (patch: { providers: Record<string, unknown>; removeProviders: string[] }) => {
        Object.assign(providers, patch.providers);
        for (const key of patch.removeProviders) delete providers[key];
      },
    },
  } as unknown as PaseoApi;
  const root = await mkdtemp(join(tmpdir(), "ppm-manager-"));
  const manager = new Manager(root);
  return {
    port: address.port,
    api,
    providers,
    manager,
    async save(protocol: "chat" | "responses" = "chat", extra: Record<string, unknown> = {}) {
      const result = await manager.action(
        {
          type: "saveConnection",
          name: "Relay",
          url: `http://127.0.0.1:${address.port}/v1`,
          protocol,
          key: "test-key",
          catalogProvider: "",
          ...extra,
        },
        api,
      );
      return result.connection!;
    },
    async close() {
      globalThis.fetch = realFetch;
      for (const socket of sockets) socket.destroy();
      server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("test all models passes with fallback limits; real problems are warnings", async () => {
  let rows: unknown[] = [{ id: "m1" }];
  const g = await gateway(() => rows);
  try {
    const connection = await g.save();
    // The gateway reports no limits; Pi gets the connection fallback (128K / 16K).
    await g.manager.action({ type: "selection", agent: "pi", connection, selected: ["m1"] }, g.api);
    assert.ok(g.providers["ppm-pi-" + connection]);
    const passed = await g.manager.action({ type: "testConnection", connection }, g.api);
    assert.match(passed.message, /全部通过/);
    assert.equal(passed.level, undefined);
    rows = [];
    const warned = await g.manager.action({ type: "testConnection", connection }, g.api);
    assert.match(warned.message, /发现 1 个问题/);
    assert.match(warned.message, /网关目录未列出/);
    assert.equal(warned.level, "warning");
  } finally {
    await g.close();
  }
});

test("a copied connection reuses the source key only on the same origin", async () => {
  const g = await gateway(() => [{ id: "m1" }]);
  try {
    const base = {
      type: "saveConnection" as const,
      url: `http://127.0.0.1:${g.port}/v1`,
      catalogProvider: "",
    };
    const source = (
      await g.manager.action({ ...base, name: "Chat", protocol: "chat", key: "test-key" }, g.api)
    ).connection!;
    const copy = await g.manager.action(
      { ...base, name: "Responses", protocol: "responses", copyKeyFrom: source },
      g.api,
    );
    assert.equal(copy.level, undefined, copy.message);
    const snapshot = await g.manager.snapshot(g.api);
    const created = snapshot.connections.find((c) => c.id === copy.connection);
    assert.equal(created?.hasKey, true);
    assert.equal(created?.error, null);
    const blank = await g.manager.action(
      { ...base, name: "Blank key", protocol: "responses", key: "", copyKeyFrom: source },
      g.api,
    );
    assert.equal(blank.level, undefined, blank.message);
    await assert.rejects(
      g.manager.action(
        { ...base, url: `http://localhost:${g.port}/v1`, name: "Other origin", protocol: "responses", copyKeyFrom: source },
        g.api,
      ),
      /重新输入 Key/,
    );
  } finally {
    await g.close();
  }
});

test("switching protocol drops empty bindings of agents that cannot use it", async () => {
  const g = await gateway(() => [{ id: "m1" }]);
  try {
    const connection = await g.save("responses");
    await g.manager.action({ type: "selection", agent: "codex", connection, selected: [] }, g.api);
    await g.manager.action({ type: "selection", agent: "pi", connection, selected: [] }, g.api);
    await g.save("chat", { id: connection });
    const agents = (await g.manager.snapshot(g.api)).bindings.map((b) => b.agent);
    assert.deepEqual(agents, ["pi"]);
  } finally {
    await g.close();
  }
});

test("providers are compared against the deployed PPM_FINGERPRINT", async () => {
  const g = await gateway(() => [{ id: "m1", context_length: 64000, max_output_tokens: 4096 }]);
  try {
    const connection = await g.save("responses", { url: `http://127.0.0.1:${g.port}` });
    await g.manager.action({ type: "selection", agent: "codex", connection, selected: ["m1"] }, g.api);
    const entry = () => g.providers["ppm-codex-" + connection] as { env: Record<string, string>; command: string[] };
    const env = () => entry().env;
    assert.ok(
      entry().command.some((arg) => /^model_providers\.ppm\.base_url="http:\/\/127\.0\.0\.1:\d+"$/.test(arg)),
      "the URL is used as entered",
    );
    assert.ok(env().PPM_FINGERPRINT);
    const first = env().PPM_GENERATION;
    // The fallback does not affect a model with gateway limits: nothing regenerates.
    await g.manager.action({ type: "fallback", connection, output: 4096 }, g.api);
    assert.equal(env().PPM_GENERATION, first);
    delete env().PPM_FINGERPRINT;
    await g.manager.action({ type: "fallback", connection, output: 2048 }, g.api);
    assert.equal(env().PPM_GENERATION, first);
    env().PPM_FINGERPRINT = "older-generator";
    await g.manager.action({ type: "fallback", connection, output: 1024 }, g.api);
    assert.notEqual(env().PPM_GENERATION, first);
  } finally {
    await g.close();
  }
});

test("a test lists a manual value the refreshed catalog breaks, and keeps the working catalog", async () => {
  let rows: unknown[] = [{ id: "m1", context_length: 64000, max_output_tokens: 4096 }];
  const g = await gateway(() => rows);
  try {
    const connection = await g.save();
    await g.manager.action({ type: "selection", agent: "pi", connection, selected: ["m1"] }, g.api);
    await g.manager.action(
      { type: "settings", connection, changes: [{ model: "m1", field: "output", value: 4000 }] },
      g.api,
    );
    rows = [{ id: "m1", context_length: 1000 }];
    const tested = await g.manager.action({ type: "testConnection", connection }, g.api);
    assert.equal(tested.level, "warning");
    assert.match(tested.message, /最大输出 4000 必须小于上下文窗口 1000/);
    assert.match(tested.message, /未保存/);
    const model = (await g.manager.snapshot(g.api)).connections[0].models[0];
    assert.equal(model.context?.value, 64000);
  } finally {
    await g.close();
  }
});

test("selection sets the default model, orders the picker and can apply to other agents", async () => {
  const g = await gateway(() => [
    { id: "zeta", context_length: 64000, max_output_tokens: 4096 },
    { id: "alpha", context_length: 64000, max_output_tokens: 4096 },
    { id: "beta", context_length: 64000, max_output_tokens: 4096 },
  ]);
  try {
    const connection = await g.save();
    await g.manager.action(
      {
        type: "selection",
        agent: "pi",
        connection,
        selected: ["zeta", "alpha", "beta"],
        default: "beta",
        alsoApply: ["omp", "opencode"],
      },
      g.api,
    );
    const snapshot = await g.manager.snapshot(g.api);
    for (const agent of ["pi", "omp", "opencode"]) {
      const binding = snapshot.bindings.find((b) => b.agent === agent);
      assert.deepEqual(binding?.selected, ["zeta", "alpha", "beta"]);
      assert.equal(binding?.default, "beta");
    }
    const pi = g.providers["ppm-pi-" + connection] as { models: Array<{ id: string; isDefault?: boolean }> };
    assert.deepEqual(pi.models.map((m) => m.id), ["ppm/beta", "ppm/alpha", "ppm/zeta"]);
    assert.equal(pi.models[0].isDefault, true);
    await assert.rejects(
      g.manager.action({ type: "selection", agent: "pi", connection, selected: ["alpha"], alsoApply: ["claude"] }, g.api),
      /不支持此连接的协议/,
    );
  } finally {
    await g.close();
  }
});

const fakeCatalog = {
  xai: {
    id: "xai",
    models: {
      "grok-x": {
        limit: { context: 500000, output: 500000 },
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        canonical_model_id: "xai/grok-x",
      },
    },
  },
  openai: {
    id: "openai",
    models: {
      "gpt-x": {
        limit: { context: 1050000, output: 128000 },
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 1, output: 2, tiers: [{ input: 2, output: 4, tier: { type: "context", size: 272000 } }] },
        canonical_model_id: "openai/gpt-x",
      },
    },
  },
  baai: {
    id: "baai",
    models: {
      "bge-m": { type: "embedding", limit: { context: 8192, output: 1 }, canonical_model_id: "baai/bge-m" },
    },
  },
};

test("refresh matches models.dev by name: limits, capabilities, suggestions and non-chat models", async () => {
  let rows: unknown[] = [{ id: "grok-x" }, { id: "gpt-x" }, { id: "bge-m" }, { id: "unknown-y" }];
  const g = await gateway(() => rows, { catalog: fakeCatalog });
  try {
    const connection = await g.save();
    let models = (await g.manager.snapshot(g.api)).connections[0].models;
    const byId = (id: string) => models.find((m) => m.id === id)!;
    assert.deepEqual(byId("grok-x").context, { value: 500000, source: "catalog", ref: "xai/grok-x" });
    assert.equal(byId("grok-x").output, undefined, "an output equal to the context is not trusted");
    assert.deepEqual(byId("grok-x").suggested, { output: 32768, reason: "output-unknown", ref: "xai/grok-x" });
    assert.deepEqual(byId("grok-x").caps, { reasoning: true, image: true, tools: true });
    assert.equal(byId("gpt-x").context?.value, 272000, "OpenAI uses the economical window by default");
    assert.equal(byId("gpt-x").full, 1050000);
    assert.equal(byId("gpt-x").output?.value, 128000);
    assert.equal(byId("bge-m").kind, "embedding");
    assert.equal(byId("unknown-y").context, undefined);
    assert.equal(byId("unknown-y").fresh, undefined, "the first catalog is not flagged as new");

    const accepted = await g.manager.action({ type: "acceptSuggestions", connection }, g.api);
    assert.match(accepted.message, /已采用 1 个推荐值/);
    assert.deepEqual((await g.manager.snapshot(g.api)).connections[0].settings?.["grok-x"]?.output, { value: 32768 });

    await g.manager.action({ type: "selection", agent: "pi", connection, selected: ["grok-x", "bge-m"] }, g.api);
    const tested = await g.manager.action({ type: "testConnection", connection }, g.api);
    assert.equal(tested.level, "warning");
    assert.match(tested.message, /bge-m：嵌入模型，不能用于对话/);

    rows = [...rows, { id: "brand-new" }];
    await g.manager.action({ type: "refresh", connection }, g.api);
    models = (await g.manager.snapshot(g.api)).connections[0].models;
    assert.equal(byId("brand-new").fresh, true);
    await g.manager.action({ type: "markSeen", connection }, g.api);
    models = (await g.manager.snapshot(g.api)).connections[0].models;
    assert.equal(byId("brand-new").fresh, undefined);
  } finally {
    await g.close();
  }
});

test("real-request tests record per-model results and never echo the key", async () => {
  const g = await gateway(() => [{ id: "good" }, { id: "bad" }], {
    post: (path, body, auth) =>
      path === "/v1/chat/completions" && body.model === "good" && auth === "Bearer test-key"
        ? { status: 200, body: { choices: [{ message: { content: "ok" } }] } }
        : { status: 404, body: { error: { message: `model not found (auth ${auth})` } } },
  });
  try {
    const connection = await g.save();
    const result = await g.manager.action({ type: "probe", connection, models: ["good", "bad"] }, g.api);
    assert.equal(result.level, "warning");
    assert.match(result.message, /1 个可用，1 个失败/);
    const probes = (await g.manager.snapshot(g.api)).connections[0].probes!;
    assert.equal(probes.good.ok, true);
    assert.equal(probes.bad.ok, false);
    assert.match(probes.bad.error ?? "", /^HTTP 404 model not found/);
    assert.equal(probes.bad.kind, "http", "the stored result is language-neutral");
    assert.ok(!probes.bad.error?.includes("test-key"), "the key is redacted");
  } finally {
    await g.close();
  }
});

test("an invalid committed state never blocks the action that repairs it", async () => {
  const g = await gateway(() => [{ id: "m1", context_length: 64000, max_output_tokens: 4096 }]);
  try {
    const connection = await g.save();
    await g.manager.action({ type: "selection", agent: "pi", connection, selected: ["m1"] }, g.api);
    // Simulate a state written under older rules: a manual output above the window.
    const statePath = join((g.manager as unknown as { storage: { root: string } }).storage.root, "state.json");
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.connections[0].settings = { m1: { output: { value: 90000 } } };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(statePath, JSON.stringify(raw), { mode: 0o600 });
    const fresh = new Manager((g.manager as unknown as { storage: { root: string } }).storage.root);
    await fresh.action(
      { type: "settings", connection, changes: [{ model: "m1", field: "output", value: null }] },
      g.api,
    );
    assert.equal((await fresh.snapshot(g.api)).connections[0].settings, undefined);
  } finally {
    await g.close();
  }
});

test("同时应用到 copies the current default even when it did not change in this save", async () => {
  const g = await gateway(() => [
    { id: "a", context_length: 64000, max_output_tokens: 4096 },
    { id: "b", context_length: 64000, max_output_tokens: 4096 },
  ]);
  try {
    const connection = await g.save();
    await g.manager.action({ type: "selection", agent: "pi", connection, selected: ["a", "b"], default: "b" }, g.api);
    await g.manager.action({ type: "selection", agent: "pi", connection, selected: ["a", "b"], alsoApply: ["omp"] }, g.api);
    const omp = (await g.manager.snapshot(g.api)).bindings.find((b) => b.agent === "omp");
    assert.equal(omp?.default, "b");
  } finally {
    await g.close();
  }
});

test("real-request tests: request shape, error bodies, unknown ids and stale results", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const g = await gateway(() => [{ id: "good" }, { id: "soft-error" }], {
    post: (_path, body) => {
      bodies.push(body as Record<string, unknown>);
      return body.model === "good"
        ? { status: 200, body: { choices: [{ message: { content: "ok" } }] } }
        : { status: 200, body: { error: { message: "quota exceeded" } } };
    },
  });
  try {
    const connection = await g.save();
    await g.manager.action({ type: "probe", connection, models: ["good", "soft-error", "not-in-catalog"] }, g.api);
    assert.equal(bodies.length, 2, "ids outside the catalog are not sent");
    assert.equal(bodies[0].max_completion_tokens, 32);
    assert.equal("max_tokens" in bodies[0], false);
    let probes = (await g.manager.snapshot(g.api)).connections[0].probes!;
    assert.equal(probes.good.ok, true);
    assert.equal(probes["soft-error"].ok, false, "a 200 with an error object is a failure");
    assert.match(probes["soft-error"].error ?? "", /quota exceeded/);
    // A changed key makes old results meaningless.
    await g.save("chat", { id: connection, key: "test-key" });
    assert.ok((await g.manager.snapshot(g.api)).connections[0].probes, "same target keeps results");
    await g.save("chat", { id: connection, url: `http://localhost:${g.port}/v1`, key: "test-key" });
    probes = (await g.manager.snapshot(g.api)).connections[0].probes!;
    assert.equal(probes, undefined);
  } finally {
    await g.close();
  }
});
