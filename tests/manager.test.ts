import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Socket } from "node:net";
import type { PaseoApi } from "@getpaseo/client";
import { Manager } from "../server/manager";

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
    await m.action({ type: "defaults", agent: "pi", output: 512 }, api);
    assert.ok(!("orphan-alias" in providers));
    rows = [
      { id: "model", context_length: 131072, max_output_tokens: 8192 },
      { id: "new", context_length: 4096, max_output_tokens: 512 },
    ];
    await m.action({ type: "refresh", connection }, api);
    const refreshed = await m.snapshot(api);
    assert.deepEqual(refreshed.bindings[0].selected, ["model"]);
    assert.deepEqual(refreshed.bindings[0].overrides.model.context, {
      value: 48000,
    });
    await m.action(
      {
        type: "override",
        ...params,
        model: "model",
        field: "context",
        value: 48000,
      },
      api,
    );
    await m.action({ type: "refresh", connection }, api);
    assert.equal(
      (await m.snapshot(api)).bindings[0].overrides.model.context?.ack,
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

async function gateway(rows: () => unknown[]) {
  // Keep these tests offline: the models.dev enrichment would otherwise fetch
  // live data for models without limits.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
    throw new Error(`blocked external request to ${url.hostname}`);
  }) as typeof fetch;
  const server = createServer((req, res) => {
    const ok = req.headers.authorization === "Bearer test-key";
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
  return {
    port: address.port,
    api,
    providers,
    manager: new Manager(root),
    async close() {
      globalThis.fetch = realFetch;
      for (const socket of sockets) socket.destroy();
      server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("test all models checks the limits the config really uses (agent defaults, overrides)", async () => {
  let rows: unknown[] = [{ id: "m1" }];
  const g = await gateway(() => rows);
  try {
    const saved = await g.manager.action(
      {
        type: "saveConnection",
        name: "Relay",
        url: `http://127.0.0.1:${g.port}/v1`,
        protocol: "chat",
        key: "test-key",
        catalogProvider: "",
      },
      g.api,
    );
    const connection = saved.connection;
    assert.ok(connection, "saveConnection returns the connection id");
    // The gateway reports no limits; Pi gets them from the agent defaults.
    await g.manager.action({ type: "defaults", agent: "pi", context: 64000, output: 4096 }, g.api);
    await g.manager.action({ type: "selection", agent: "pi", connection, selected: ["m1"] }, g.api);
    assert.ok(g.providers["ppm-pi-" + connection]);
    const passed = await g.manager.action({ type: "testConnection", connection }, g.api);
    assert.match(passed.message, /全部通过/);
    assert.equal(passed.level, undefined);
    // A real issue is reported as a warning, not a success.
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
    // A blank key field on a copy also means "use the source key".
    const blank = await g.manager.action(
      { ...base, name: "Blank key", protocol: "responses", key: "", copyKeyFrom: source },
      g.api,
    );
    assert.equal(blank.level, undefined, blank.message);
    await assert.rejects(
      g.manager.action(
        {
          ...base,
          url: `http://localhost:${g.port}/v1`,
          name: "Other origin",
          protocol: "responses",
          copyKeyFrom: source,
        },
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
    const action = {
      type: "saveConnection" as const,
      name: "Relay",
      url: `http://127.0.0.1:${g.port}/v1`,
      catalogProvider: "",
      key: "test-key",
    };
    const connection = (await g.manager.action({ ...action, protocol: "responses" }, g.api)).connection!;
    await g.manager.action({ type: "selection", agent: "codex", connection, selected: [] }, g.api);
    await g.manager.action({ type: "selection", agent: "pi", connection, selected: [] }, g.api);
    await g.manager.action({ ...action, id: connection, protocol: "chat" }, g.api);
    const agents = (await g.manager.snapshot(g.api)).bindings.map((b) => b.agent);
    assert.deepEqual(agents, ["pi"]);
  } finally {
    await g.close();
  }
});

test("providers are compared against the deployed PPM_FINGERPRINT", async () => {
  const g = await gateway(() => [{ id: "m1", context_length: 64000, max_output_tokens: 4096 }]);
  try {
    const connection = (
      await g.manager.action(
        {
          type: "saveConnection",
          name: "Relay",
          url: `http://127.0.0.1:${g.port}`,
          protocol: "responses",
          key: "test-key",
          catalogProvider: "",
        },
        g.api,
      )
    ).connection!;
    await g.manager.action({ type: "selection", agent: "codex", connection, selected: ["m1"] }, g.api);
    const env = () => (g.providers["ppm-codex-" + connection] as { env: Record<string, string> }).env;
    const toml = await readFile(join(env().CODEX_HOME, "config.toml"), "utf8");
    assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:\d+"/, "the URL is used as entered");
    assert.ok(env().PPM_FINGERPRINT);
    const first = env().PPM_GENERATION;
    // An unrelated action leaves an up-to-date provider alone.
    await g.manager.action({ type: "defaults", agent: "pi", context: 64000, output: 4096 }, g.api);
    assert.equal(env().PPM_GENERATION, first);
    // A provider generated before PPM_FINGERPRINT existed is not regenerated either.
    delete env().PPM_FINGERPRINT;
    await g.manager.action({ type: "defaults", agent: "pi", context: 64000, output: 2048 }, g.api);
    assert.equal(env().PPM_GENERATION, first);
    // A deployed fingerprint that differs (an older generator) regenerates it.
    env().PPM_FINGERPRINT = "older-generator";
    await g.manager.action({ type: "defaults", agent: "pi", context: 64000, output: 1024 }, g.api);
    assert.notEqual(env().PPM_GENERATION, first);
  } finally {
    await g.close();
  }
});

test("a test lists limits that the refreshed catalog breaks, and keeps the working catalog", async () => {
  let rows: unknown[] = [{ id: "m1", context_length: 64000, max_output_tokens: 4096 }];
  const g = await gateway(() => rows);
  try {
    const connection = (
      await g.manager.action(
        {
          type: "saveConnection",
          name: "Relay",
          url: `http://127.0.0.1:${g.port}/v1`,
          protocol: "chat",
          key: "test-key",
          catalogProvider: "",
        },
        g.api,
      )
    ).connection!;
    await g.manager.action({ type: "selection", agent: "pi", connection, selected: ["m1"] }, g.api);
    rows = [{ id: "m1", context_length: 1000, max_output_tokens: 2000 }];
    const tested = await g.manager.action({ type: "testConnection", connection }, g.api);
    assert.equal(tested.level, "warning");
    assert.match(tested.message, /最大输出 2000 必须小于上下文窗口 1000/);
    assert.match(tested.message, /未保存/);
    const model = (await g.manager.snapshot(g.api)).connections[0].models[0];
    assert.equal(model.context?.value, 64000);
  } finally {
    await g.close();
  }
});
