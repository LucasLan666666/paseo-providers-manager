import test from "node:test";
import assert from "node:assert/strict";
import { CatalogError, discover } from "../server/catalog";
import type { Model } from "../shared/contracts";

type Connection = Parameters<typeof discover>[0];
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface FetchCall {
  url: URL;
  headers: Headers;
  init: FetchInit;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handler: (call: FetchCall) => unknown): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const call: FetchCall = {
      url,
      headers: new Headers(init?.headers),
      init,
    };
    calls.push(call);
    const result = await handler(call);
    return result instanceof Response ? result : json(result);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    url: "https://gateway.test/v1",
    protocol: "chat",
    key: "sk-test-secret",
    catalogProvider: "",
    ...overrides,
  };
}

// Most cases are about the gateway protocol, not models.dev. Avoid a live
// catalog lookup; tests that exercise enrichment always pass their own loader.
function discoverTest(
  input: Connection,
  options: Parameters<typeof discover>[1] = {},
): Promise<Model[]> {
  return discover(input, { loadCatalog: async () => null, ...options });
}

test("discovers OpenAI-compatible chat models and reads gateway limits", async () => {
  const mock = mockFetch(() => ({
    object: "list",
    data: [
      {
        id: "alpha",
        name: "Alpha",
        context_length: 128_000,
        max_output_tokens: 16_384,
      },
      { id: "beta", context_length: 8_192 },
    ],
  }));

  const models = await discoverTest(connection({ url: "https://gateway.test/api/v1/" }), {
    fetch: mock.fetch,
  });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.equal(call.url.href, "https://gateway.test/api/v1/models");
  assert.equal(call.init?.method, "GET");
  assert.equal(call.init?.redirect, "error");
  assert.equal(call.headers.get("accept"), "application/json");
  assert.equal(call.headers.get("authorization"), "Bearer sk-test-secret");

  assert.deepEqual(models, [
    {
      id: "alpha",
      label: "Alpha",
      listed: true,
      context: { value: 128_000, source: "gateway" },
      output: { value: 16_384, source: "gateway" },
    },
    {
      id: "beta",
      label: "beta",
      listed: true,
      context: { value: 8_192, source: "gateway" },
    },
  ]);
});

test("supports responses protocol on a bare localhost URL without a key", async () => {
  const mock = mockFetch(() => ({ data: [{ id: "local-model" }] }));

  const models = await discoverTest(
    connection({ url: "localhost:11434", protocol: "responses", key: "" }),
    { fetch: mock.fetch },
  );

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.equal(call.url.href, "http://localhost:11434/models");
  assert.equal(call.headers.get("authorization"), null);
  assert.equal(call.headers.get("x-api-key"), null);
  assert.deepEqual(models, [{ id: "local-model", label: "local-model", listed: true }]);
});

test("paginates Anthropic models with after_id and deduplicates pages", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.searchParams.get("after_id") === null) {
      return {
        data: [
          { id: "claude-1", display_name: "Claude One" },
          { id: "claude-2", display_name: "Claude Two" },
        ],
        has_more: true,
        last_id: "claude-2",
      };
    }
    return {
      data: [
        { id: "claude-3", display_name: "Claude Three" },
        { id: "claude-1", display_name: "Claude One Duplicate" },
      ],
      has_more: false,
      last_id: "claude-3",
    };
  });

  const models = await discoverTest(connection({ url: "https://api.anthropic.com", protocol: "anthropic" }), {
    fetch: mock.fetch,
  });

  assert.equal(mock.calls.length, 2);
  const first = mock.calls[0];
  const second = mock.calls[1];
  assert.equal(first.url.pathname, "/v1/models");
  assert.equal(first.url.searchParams.get("limit"), "1000");
  assert.equal(first.url.searchParams.get("after_id"), null);
  assert.equal(first.headers.get("x-api-key"), "sk-test-secret");
  assert.equal(first.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(second.url.searchParams.get("after_id"), "claude-2");
  assert.equal(second.url.searchParams.get("limit"), "1000");

  assert.deepEqual(models, [
    { id: "claude-1", label: "Claude One", listed: true },
    { id: "claude-2", label: "Claude Two", listed: true },
    { id: "claude-3", label: "Claude Three", listed: true },
  ]);
});

test("paginates Gemini models, strips the models/ prefix, and uses token limits", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.searchParams.get("pageToken") === null) {
      return {
        models: [
          {
            name: "models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            inputTokenLimit: 1_048_576,
            outputTokenLimit: 65_536,
          },
        ],
        nextPageToken: "page-two",
      };
    }
    return {
      models: [
        {
          name: "models/gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
        },
      ],
    };
  });

  const models = await discoverTest(connection({ url: "https://generativelanguage.googleapis.com", protocol: "gemini" }), {
    fetch: mock.fetch,
  });

  assert.equal(mock.calls.length, 2);
  const first = mock.calls[0];
  const second = mock.calls[1];
  assert.equal(first.url.pathname, "/v1beta/models");
  assert.equal(first.url.searchParams.get("pageSize"), "1000");
  assert.equal(second.url.searchParams.get("pageToken"), "page-two");
  assert.equal(first.headers.get("x-goog-api-key"), "sk-test-secret");
  assert.equal(first.headers.get("authorization"), null);

  assert.deepEqual(models, [
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      listed: true,
      context: { value: 1_048_576, source: "gateway" },
      output: { value: 65_536, source: "gateway" },
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      listed: true,
      context: { value: 1_048_576, source: "gateway" },
      output: { value: 65_536, source: "gateway" },
    },
  ]);
});

test("does not consult models.dev when the gateway supplies both limits", async () => {
  const mock = mockFetch(() => ({
    data: [{ id: "complete", context_length: 1_000, max_output_tokens: 100 }],
  }));
  let catalogCalled = false;

  const models = await discoverTest(connection({ catalogProvider: "provider" }), {
    fetch: mock.fetch,
    loadCatalog: async () => {
      catalogCalled = true;
      return {};
    },
  });

  assert.equal(catalogCalled, false);
  assert.deepEqual(models, [
    {
      id: "complete",
      label: "complete",
      listed: true,
      context: { value: 1_000, source: "gateway" },
      output: { value: 100, source: "gateway" },
    },
  ]);
});

test("infers a unique catalog provider from the official api URL with version/trailing-slash normalization", async () => {
  const mock = mockFetch(() => ({ data: [{ id: "implicit-model" }] }));
  let receivedProvider: string | undefined;

  const models = await discoverTest(connection({ url: "https://official.test", catalogProvider: "" }), {
    fetch: mock.fetch,
    loadCatalog: async (provider) => {
      receivedProvider = provider;
      return {
        official: {
          id: "official",
          api: "https://official.test/v1/",
          models: {
            "implicit-model": { limit: { context: 111, output: 22 } },
          },
        },
      };
    },
  });

  assert.equal(receivedProvider, "");
  assert.deepEqual(models, [
    {
      id: "implicit-model",
      label: "implicit-model",
      listed: true,
      context: { value: 111, source: "catalog" },
      output: { value: 22, source: "catalog" },
    },
  ]);
});

test("does not infer a provider when the api URL is ambiguous or unrelated", async () => {
  const mock = mockFetch(() => ({ data: [{ id: "model-a" }] }));

  const ambiguous = await discoverTest(connection({ url: "https://shared.test/v1" }), {
    fetch: mock.fetch,
    loadCatalog: async () => ({
      first: {
        id: "first",
        api: "https://shared.test/v1",
        models: { "model-a": { limit: { context: 10, output: 5 } } },
      },
      second: {
        id: "second",
        api: "https://shared.test/v1/",
        models: { "model-a": { limit: { context: 20, output: 6 } } },
      },
    }),
  });
  assert.deepEqual(ambiguous, [{ id: "model-a", label: "model-a", listed: true }]);

  const unrelated = await discoverTest(connection({ url: "https://private.test/v1" }), {
    fetch: mock.fetch,
    loadCatalog: async () => ({
      official: {
        id: "official",
        api: "https://official.test/v1",
        models: { "model-a": { limit: { context: 10, output: 5 } } },
      },
    }),
  });
  assert.deepEqual(unrelated, [{ id: "model-a", label: "model-a", listed: true }]);

  const differentVersion = await discoverTest(connection({ url: "https://official.test/v2" }), {
    fetch: mock.fetch,
    loadCatalog: async () => ({
      official: {
        id: "official",
        api: "https://official.test/v1",
        models: { "model-a": { limit: { context: 10, output: 5 } } },
      },
    }),
  });
  assert.deepEqual(differentVersion, [{ id: "model-a", label: "model-a", listed: true }]);
});

test("rejects a malformed model list instead of treating it as empty and complete", async () => {
  const mock = mockFetch(() => ({
    data: { id: "not-a-list" },
    models: [{ id: "fallback-that-must-not-hide-the-error" }],
  }));

  await assert.rejects(
    discoverTest(connection(), { fetch: mock.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, "invalid-response");
      return true;
    },
  );
  assert.equal(mock.calls.length, 1);
});

test("rejects a page with a malformed model entry instead of returning a partial list", async () => {
  const mock = mockFetch(() => ({
    data: [{ id: "valid" }, { id: 42 }],
  }));

  await assert.rejects(
    discoverTest(connection(), { fetch: mock.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, "invalid-response");
      return true;
    },
  );
  assert.equal(mock.calls.length, 1);
});

test("rejects a malformed later page instead of returning earlier pages", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.searchParams.get("after_id") === null) {
      return {
        data: [{ id: "one" }],
        has_more: true,
        last_id: "one",
      };
    }
    return { data: [{ id: "two" }, {}] };
  });

  await assert.rejects(
    discoverTest(connection({ url: "https://api.anthropic.com", protocol: "anthropic" }), {
      fetch: mock.fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, "invalid-response");
      return true;
    },
  );
  assert.equal(mock.calls.length, 2);
});

test("fails explicitly when the finite model guard is exceeded", async () => {
  const mock = mockFetch(() => ({ data: [{ id: "one" }, { id: "two" }] }));

  await assert.rejects(
    discoverTest(connection(), { fetch: mock.fetch, maxModels: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, "pagination");
      return true;
    },
  );
  assert.equal(mock.calls.length, 1);
});

test("fails explicitly when the finite page guard is exceeded", async () => {
  const mock = mockFetch(() => ({
    data: [{ id: "one" }],
    has_more: true,
    last_id: "one",
  }));

  await assert.rejects(
    discoverTest(connection({ url: "https://api.anthropic.com", protocol: "anthropic" }), {
      fetch: mock.fetch,
      maxPages: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, "pagination");
      return true;
    },
  );
  assert.equal(mock.calls.length, 1);
});

test("fails explicitly when the provider response exceeds the size guard", async () => {
  const mock = mockFetch(
    () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(33 * 1024 * 1024) },
      }),
  );

  await assert.rejects(
    discoverTest(connection(), { fetch: mock.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, "invalid-response");
      return true;
    },
  );
  assert.equal(mock.calls.length, 1);
});

test("fills only missing fields from an exact models.dev match and keeps gateway precedence", async () => {
  const mock = mockFetch(() => ({
    data: [
      { id: "claude-exact", context_length: 123 },
      { id: "claude-output-only" },
      { id: "claude-exact-extra" },
    ],
  }));
  let catalogCalls = 0;

  const models = await discoverTest(connection({ catalogProvider: "anthropic" }), {
    fetch: mock.fetch,
    loadCatalog: async (provider) => {
      catalogCalls += 1;
      assert.equal(provider, "anthropic");
      return {
        anthropic: {
          models: {
            "claude-exact": { limit: { context: 999, output: 456 } },
            "claude-output-only": { limit: { context: 777, output: 333 } },
          },
        },
      };
    },
  });

  assert.equal(catalogCalls, 1);
  assert.deepEqual(models, [
    {
      id: "claude-exact",
      label: "claude-exact",
      listed: true,
      context: { value: 123, source: "gateway" },
      output: { value: 456, source: "catalog" },
    },
    {
      id: "claude-output-only",
      label: "claude-output-only",
      listed: true,
      context: { value: 777, source: "catalog" },
      output: { value: 333, source: "catalog" },
    },
    { id: "claude-exact-extra", label: "claude-exact-extra", listed: true },
  ]);
});

test("does not match a different catalog provider or a suffixed model id", async () => {
  const mock = mockFetch(() => ({
    data: [{ id: "model-a" }, { id: "model-b" }],
  }));

  const models = await discoverTest(connection({ catalogProvider: "provider-a" }), {
    fetch: mock.fetch,
    loadCatalog: async () => ({
      "provider-b": {
        models: {
          "model-a": { limit: { context: 100, output: 50 } },
        },
      },
      "provider-a": {
        models: {
          "model-a-pro": { limit: { context: 200, output: 60 } },
        },
      },
    }),
  });

  assert.deepEqual(models, [
    { id: "model-a", label: "model-a", listed: true },
    { id: "model-b", label: "model-b", listed: true },
  ]);
});

test("never guesses limits from unrelated or malformed gateway fields", async () => {
  const mock = mockFetch(() => ({
    data: [
      { id: "zero", context_length: 0, max_output_tokens: 0 },
      { id: "fraction", context_length: 8_192.5, max_tokens: 4_096 },
      {
        id: "string-values",
        context_length: "16384",
        max_output_tokens: "2048",
      },
      { id: "missing", top_provider: { context_length: null } },
    ],
  }));

  const models = await discoverTest(connection(), { fetch: mock.fetch });

  assert.deepEqual(models, [
    { id: "zero", label: "zero", listed: true },
    { id: "fraction", label: "fraction", listed: true },
    {
      id: "string-values",
      label: "string-values",
      listed: true,
      context: { value: 16_384, source: "gateway" },
      output: { value: 2_048, source: "gateway" },
    },
    { id: "missing", label: "missing", listed: true },
  ]);
});

test("keeps discovered models when the optional catalog lookup fails", async () => {
  const mock = mockFetch(() => ({ data: [{ id: "resilient" }] }));

  const models = await discoverTest(connection({ catalogProvider: "provider" }), {
    fetch: mock.fetch,
    loadCatalog: async () => {
      throw new Error("catalog offline");
    },
  });

  assert.deepEqual(models, [{ id: "resilient", label: "resilient", listed: true }]);
});

test("sends credentials only to the configured gateway, never to models.dev", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.href === "https://catalog.test/api.json") {
      return { catalog: { models: { model: { limit: { context: 10, output: 5 } } } } };
    }
    return { data: [{ id: "model" }] };
  });

  const models = await discover(connection({ catalogProvider: "catalog" }), {
    fetch: mock.fetch,
    catalogUrl: "https://catalog.test/api.json",
  });

  assert.equal(mock.calls.length, 2);
  const gatewayCall = mock.calls.find((call) => call.url.hostname === "gateway.test");
  const catalogCall = mock.calls.find((call) => call.url.hostname === "catalog.test");
  assert.ok(gatewayCall);
  assert.ok(catalogCall);

  assert.equal(gatewayCall.headers.get("authorization"), "Bearer sk-test-secret");
  assert.equal(catalogCall.headers.get("authorization"), null);
  assert.equal(catalogCall.headers.get("x-api-key"), null);
  assert.equal(catalogCall.headers.get("x-goog-api-key"), null);
  assert.equal(catalogCall.url.search, "");
  assert.equal(catalogCall.init?.redirect, "error");
  assert.deepEqual(models, [
    {
      id: "model",
      label: "model",
      listed: true,
      context: { value: 10, source: "catalog" },
      output: { value: 5, source: "catalog" },
    },
  ]);
});

test("refuses cross-origin pagination instead of leaking credentials", async () => {
  const mock = mockFetch(() => ({
    data: [{ id: "one" }],
    links: { next: "https://evil.test/collect" },
  }));

  await assert.rejects(
    discoverTest(connection(), { fetch: mock.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, "pagination");
      assert.equal(error.message.includes("sk-test-secret"), false);
      return true;
    },
  );
  assert.equal(mock.calls.length, 1);
});

test("stops pagination loops with a safe error", async () => {
  const mock = mockFetch(() => ({
    data: [{ id: "same" }],
    has_more: true,
    last_id: "same",
  }));

  await assert.rejects(
    discoverTest(connection({ url: "https://api.anthropic.com", protocol: "anthropic" }), {
      fetch: mock.fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, "pagination");
      return true;
    },
  );
  assert.equal(mock.calls.length, 2);
});

test("reports authentication failures without exposing the key", async () => {
  const mock = mockFetch(() => new Response("unauthorized", { status: 401 }));

  await assert.rejects(
    discoverTest(connection(), { fetch: mock.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, "auth");
      assert.equal(error.status, 401);
      assert.equal(error.message.includes("sk-test-secret"), false);
      assert.equal(error.message.includes("unauthorized"), false);
      return true;
    },
  );
});

test("rejects URLs containing credentials before any request", async () => {
  const mock = mockFetch(() => ({ data: [] }));

  await assert.rejects(
    discoverTest(connection({ url: "https://user:password@gateway.test/v1" }), {
      fetch: mock.fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, "invalid-url");
      assert.equal(error.message.includes("password"), false);
      return true;
    },
  );
  assert.equal(mock.calls.length, 0);
});

test("returns an empty list when the provider exposes no models", async () => {
  const mock = mockFetch(() => ({ object: "list", data: [] }));

  const models = await discoverTest(connection(), { fetch: mock.fetch });

  assert.deepEqual(models, []);
});

test("an output listed as equal to the context is not applied from an exact provider match", async () => {
  const mock = mockFetch(() => ({ data: [{ id: "k" }] }));
  const models = await discoverTest(connection({ catalogProvider: "vendor" }), {
    fetch: mock.fetch,
    loadCatalog: async () => ({ vendor: { models: { k: { limit: { context: 262144, output: 262144 } } } } }),
  });
  assert.deepEqual(models, [
    { id: "k", label: "k", listed: true, context: { value: 262144, source: "catalog" } },
  ]);
});
