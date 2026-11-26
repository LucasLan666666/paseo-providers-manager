import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { pick, resolveLang } from "../shared/i18n";
import { protocolEndpoint } from "../shared/protocols";
import { L, withLang } from "../server/i18n";
import { Manager } from "../server/manager";
import { Jobs } from "../server/jobs";
import { discover } from "../server/catalog";
import { formatRelativeTime, parseTokens, refreshLabel } from "../client/format";

test("the language choice resolves against Paseo's locale", () => {
  assert.equal(resolveLang("system", "zh-CN"), "zh-CN");
  assert.equal(resolveLang("system", "zh"), "zh-CN");
  assert.equal(resolveLang("system", "en"), "en");
  assert.equal(resolveLang("system", "ja"), "en");
  assert.equal(resolveLang("system", undefined), "en");
  assert.equal(resolveLang("zh-CN", "en"), "zh-CN");
  assert.equal(resolveLang("en", "zh-CN"), "en");
  assert.equal(pick("en", "中", "En"), "En");
  assert.equal(pick("zh-CN", "中", "En"), "中");
});

test("server messages follow the request language; no language means Chinese", async () => {
  assert.equal(L("中", "En"), "中");
  assert.equal(withLang("en", () => L("中", "En")), "En");
  assert.equal(withLang(undefined, () => L("中", "En")), "中");
  // Concurrent requests keep their own language across awaits.
  const [zh, en] = await Promise.all([
    withLang("zh-CN", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return L("中", "En");
    }),
    withLang("en", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return L("中", "En");
    }),
  ]);
  assert.deepEqual([zh, en], ["中", "En"]);
});

test("manager results, errors and agent descriptions use the request language", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-i18n-"));
  const api = {
    config: { get: async () => ({ config: { providers: {} } }), patch: async () => {} },
  } as unknown as PaseoApi;
  try {
    const manager = new Manager(root);
    const snapshot = await withLang("en", () => manager.snapshot(api));
    const claude = snapshot.agents.find((agent) => agent.id === "claude");
    assert.match(claude?.detail ?? "", /^Anthropic Messages gateway/);
    const zh = await withLang("zh-CN", () => manager.snapshot(api));
    assert.match(zh.agents.find((agent) => agent.id === "claude")?.detail ?? "", /网关/);
    await assert.rejects(
      withLang("en", () => manager.action({ type: "testConnection", connection: "00000000-0000-4000-8000-000000000000" }, api)),
      /Connection not found/,
    );
    await assert.rejects(
      manager.action({ type: "testConnection", connection: "00000000-0000-4000-8000-000000000000" }, api),
      /找不到连接/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("job polling reports in the poller's language", async () => {
  const jobs = new Jobs();
  await assert.rejects(withLang("en", () => jobs.wait("00000000-0000-4000-8000-000000000000")), /operation has ended/);
  await assert.rejects(jobs.wait("00000000-0000-4000-8000-000000000000"), /操作已结束/);
});

test("gateway errors are translated", async () => {
  const fetchImpl = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  const connection = { url: "https://gateway.test/v1", protocol: "chat" as const, key: "k", catalogProvider: "" };
  await assert.rejects(
    withLang("en", () => discover(connection, { fetch: fetchImpl, loadCatalog: async () => null })),
    /The gateway rejected the API key/,
  );
  await assert.rejects(discover(connection, { fetch: fetchImpl, loadCatalog: async () => null }), /网关拒绝了 API Key/);
});

test("client formatting helpers are translated", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  assert.equal(refreshLabel(now - 3 * 60 * 60 * 1000, "en", now), "Refreshed 3 hours ago");
  assert.equal(refreshLabel(now - 3 * 60 * 60 * 1000, "zh-CN", now), "3 小时前刷新");
  assert.equal(formatRelativeTime(now - 60 * 1000, "en", now), "1 minute ago");
  assert.equal(refreshLabel(null, "en", now), "Never refreshed");
  assert.match(parseTokens("abc", "en").error ?? "", /whole number/);
  assert.equal(parseTokens("128k", "en").value, 128000);
  assert.equal(protocolEndpoint("responses", "en"), "POST {base}/responses");
  assert.equal(protocolEndpoint("responses", "zh-CN"), "POST {地址}/responses");
});
