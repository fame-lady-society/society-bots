import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthorityError, apiFetch } from "../src/api";
import { createDataClient } from "../src/data-client";
import { inboxStatusSchema } from "../src/telegram-contracts";

test("client decodes reader-only status and rejects partial global metadata", () => {
  assert.deepEqual(inboxStatusSchema.parse({ chats: [] }), { chats: [] });
  assert.equal(
    inboxStatusSchema.safeParse({ chats: [], username: "leak" }).success,
    false,
  );
});
test("API requests preserve authorization denials as typed errors", async (t) => {
  for (const status of [401, 403] as const) {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status }),
    );
    await assert.rejects(
      apiFetch("/api/access"),
      (e: unknown) => e instanceof AuthorityError && e.status === status,
    );
    t.mock.restoreAll();
  }
});
test("query and mutation authorization failures notify the authority boundary once", async () => {
  let refreshes = 0;
  const client = createDataClient(() => {
    refreshes++;
  });
  await assert.rejects(
    client.fetchQuery({
      queryKey: ["groups"],
      retry: false,
      queryFn: async () => {
        throw new AuthorityError(403);
      },
    }),
  );
  assert.equal(refreshes, 1);
  const mutation = client.getMutationCache().build(client, {
    mutationFn: async () => {
      throw new AuthorityError(401);
    },
  });
  await assert.rejects(mutation.execute(undefined));
  assert.equal(refreshes, 1);
  client.clear();
  const fresh = createDataClient(() => {
    refreshes++;
  });
  const failedMutation = fresh.getMutationCache().build(fresh, {
    mutationFn: async () => {
      throw new AuthorityError(403);
    },
  });
  await assert.rejects(failedMutation.execute(undefined));
  assert.equal(refreshes, 2);
  fresh.clear();
});
test("ordinary network errors do not reset authority", async () => {
  let refreshes = 0;
  const client = createDataClient(() => {
    refreshes++;
  });
  await assert.rejects(
    client.fetchQuery({
      queryKey: ["groups"],
      retry: false,
      queryFn: async () => {
        throw new Error("offline");
      },
    }),
  );
  assert.equal(refreshes, 0);
  client.clear();
});

test("runtime 404 clears cached evidence and refreshes authority without retry", async (t) => {
  const { runtimeFetch } = await import("../src/api");
  let refreshes = 0;
  const client = createDataClient(() => refreshes++);
  client.setQueryData(["runtime-status", "overclaw-leader"], {
    private: "old evidence",
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 404 }),
  );
  await assert.rejects(
    client.fetchQuery({
      queryKey: ["denied-runtime"],
      retry: false,
      queryFn: async () => runtimeFetch("/api/runtimes/overclaw-leader/status"),
    }),
    (error: unknown) => error instanceof AuthorityError && error.status === 404,
  );
  assert.equal(refreshes, 1);
  assert.equal(client.getQueryCache().getAll().length, 0);
  client.clear();
});
