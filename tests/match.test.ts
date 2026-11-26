import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "../shared/contracts";
import { enrichModels, normalizeModelId } from "../server/match";

const chat = (limit: { context: number; output: number }, extra: Record<string, unknown> = {}) => ({
  limit,
  modalities: { input: ["text"], output: ["text"] },
  tool_call: true,
  ...extra,
});

const catalog = {
  minimax: {
    models: { "MiniMax-M2.7": chat({ context: 204800, output: 131072 }, { canonical_model_id: "minimax/MiniMax-M2.7" }) },
  },
  // A relay lists the model under its own id; its canonical id points at the vendor.
  venice: {
    models: { "minimax-m27": chat({ context: 198000, output: 32768 }, { canonical_model_id: "minimax/MiniMax-M2.7" }) },
  },
  zhipuai: {
    models: { "glm-9": chat({ context: 204800, output: 131072 }, { canonical_model_id: "zhipuai/glm-9" }) },
  },
  // A coding plan of another vendor re-lists glm-9 with a small output cap.
  "alibaba-coding-plan": {
    models: { "glm-9": chat({ context: 202752, output: 16384 }, { canonical_model_id: "zhipuai/glm-9" }) },
  },
  openai: {
    models: {
      "gpt-9-sol": chat({ context: 1050000, output: 128000 }, { canonical_model_id: "openai/gpt-9-sol" }),
      "gpt-9-luna": chat({ context: 1050000, output: 64000 }, { canonical_model_id: "openai/gpt-9-luna" }),
    },
  },
  thirdparty: {
    models: { "only-here": chat({ context: 32000, output: 4000 }) },
  },
};

const models = (...ids: string[]): Model[] => ids.map((id) => ({ id, label: id, listed: true }));

test("normalizes vendor prefixes, :latest and date suffixes", () => {
  assert.equal(normalizeModelId("x-ai/Grok-4.6"), "grok-4.6");
  assert.equal(normalizeModelId("bge-large-zh:latest"), "bge-large-zh");
  assert.equal(normalizeModelId("claude-opus-4-5@20251101"), "claude-opus-4-5");
  assert.equal(normalizeModelId("glm-4.6-20251208"), "glm-4.6");
});

test("a relay id reaches the vendor's row through its canonical id, capped by rows of that exact id", () => {
  const list = models("minimax-m27");
  enrichModels(list, catalog);
  // venice lists "minimax-m27" itself with smaller limits: the smaller values win.
  assert.deepEqual(list[0].context, { value: 198000, source: "catalog", ref: "minimax/MiniMax-M2.7" });
  assert.equal(list[0].output?.value, 32768);
  const vendorId = models("MiniMax-M2.7");
  enrichModels(vendorId, catalog);
  assert.equal(vendorId[0].context?.value, 204800, "the vendor's own id keeps the vendor values");
});

test("hits that only match after dropping -latest, @region or a date are suggestions", () => {
  const list = models("glm-9-latest", "glm-9@eu", "glm-9-20260101", "ZhipuAI/GLM-9");
  enrichModels(list, catalog);
  for (const model of list.slice(0, 3)) {
    assert.equal(model.context, undefined, model.id);
    assert.equal(model.suggested?.reason, "loose", model.id);
  }
  assert.equal(list[3].context?.value, 204800, "case and a vendor prefix are only spelling");
});

test("an explicit provider offers a suggestion for an output listed as equal to the context", () => {
  const list = models("only-here");
  enrichModels(list, { thirdparty: { models: { "only-here": chat({ context: 64000, output: 64000 }) } } }, { provider: "thirdparty" });
  assert.deepEqual(list[0].suggested, { output: 16000, reason: "output-unknown", ref: "thirdparty/only-here" });
});

test("the vendor's own row wins over another vendor's plan", () => {
  const list = models("glm-9");
  enrichModels(list, catalog);
  assert.equal(list[0].output?.value, 131072);
  assert.equal(list[0].context?.ref, "zhipuai/glm-9");
});

test("third-party-only hits and family guesses are suggestions, never applied", () => {
  const list = models("only-here", "gpt-9", "gpt-9-sol-highspeed");
  enrichModels(list, catalog);
  const [third, family, suffix] = list;
  assert.equal(third.context, undefined);
  assert.deepEqual(third.suggested, { context: 32000, output: 4000, reason: "loose", ref: "thirdparty/only-here" });
  assert.equal(family.context, undefined);
  assert.equal(family.suggested?.reason, "guess");
  assert.equal(family.suggested?.output, 64000, "the smallest family value is suggested");
  assert.equal(suffix.suggested?.reason, "guess");
  assert.equal(suffix.suggested?.ref, "openai/gpt-9-sol");
});

test("non-chat models are recognized by name when the catalog has no row", () => {
  const list = models("bge-reranker-v2-m3", "qwen3-embedding:8b", "gpt-image-2.6-flare", "plain-chat");
  enrichModels(list, catalog);
  assert.deepEqual(
    list.map((m) => m.kind),
    ["reranking", "embedding", "image", undefined],
  );
});

test("gateway values are never overwritten and an explicit provider keeps limits strict", () => {
  const gateway = models("glm-9");
  gateway[0].context = { value: 1000, source: "gateway" };
  enrichModels(gateway, catalog);
  assert.deepEqual(gateway[0].context, { value: 1000, source: "gateway" });
  assert.equal(gateway[0].output?.value, 131072);

  const strict = models("glm-9");
  enrichModels(strict, catalog, { provider: "zhipuai" });
  assert.equal(strict[0].context, undefined, "limits come only from discover() for an explicit provider");
  assert.deepEqual(strict[0].caps, { image: false, tools: true });
});
