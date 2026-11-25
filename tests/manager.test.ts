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
