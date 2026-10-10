import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { parseFamePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";
import { validateMetadata, type TokenMetadata } from "./decode.ts";
import { digest, historyScope, type Scope } from "./model.ts";
import { activeScopeKey } from "./keys.ts";
import { sampledPolicy } from "./sampled-market.ts";

/** Deployment changes available code; this record selects the prepared dataset.
 * Store JSON as a string so DynamoDB map ordering cannot change its digest. */
export function dataset(scope: Scope, metadata: TokenMetadata) {
  validateMetadata(scope, metadata);
  const body = JSON.stringify({
    version: "fame-history-dataset-v1",
    registry: scope.registry,
    metadata,
  });
  return { scopeId: scope.id, definition: body, definitionHash: digest(body) };
}
export function decodeDataset(row: Record<string, unknown>) {
  if (
    typeof row.definition !== "string" ||
    digest(row.definition) !== row.definitionHash
  )
    throw new Error(
      "History dataset definition missing or corrupt; prepare the active dataset before deployment",
    );
  const value = JSON.parse(row.definition);
  if (value.version !== "fame-history-dataset-v1")
    throw new Error("Unknown history dataset version");
  const scope = historyScope(parseFamePoolStateRegistry(value.registry));
  if (scope.id !== row.scopeId)
    throw new Error("History dataset scope mismatch");
  validateMetadata(scope, value.metadata);
  sampledPolicy(scope); // Reject unsupported routes before collection or serving.
  return { scope, metadata: value.metadata as TokenMetadata };
}
export const datasetKey = (scopeId: string) => ({
  pk: `dataset:${scopeId}`,
  sk: "definition",
});
// Definitions are immutable. Always reread the small active pointer, but keep
// the validated definition on warm readers without another DynamoDB request.
const definitions = new WeakMap<
  DynamoDBDocumentClient,
  Map<string, ReturnType<typeof decodeDataset>>
>();
export async function activeDataset(
  table: string,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
  signal?: AbortSignal,
) {
  const { Item } = await db.send(
    new GetCommand({
      TableName: table,
      Key: activeScopeKey,
      ConsistentRead: true,
    }),
    { abortSignal: signal },
  );
  if (!Item) throw new Error("History active dataset is not prepared");
  if (typeof Item.scopeId !== "string" || !/^[a-f0-9]{64}$/.test(Item.scopeId))
    throw new Error("Invalid active scope");
  let cache = definitions.get(db);
  if (!cache) definitions.set(db, (cache = new Map()));
  const key = `${table}:${Item.scopeId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const definition = await db.send(
    new GetCommand({
      TableName: table,
      Key: datasetKey(Item.scopeId),
      ConsistentRead: true,
    }),
    { abortSignal: signal },
  );
  if (definition.Item?.scopeId !== Item.scopeId)
    throw new Error("Active dataset definition mismatch");
  const selected = decodeDataset(definition.Item);
  if (cache.size >= 16) cache.clear();
  cache.set(key, selected);
  return selected;
}
