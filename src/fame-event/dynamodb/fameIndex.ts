import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { DYNAMODB_FAME_INDEX_TABLE_NAME } from "../lambdas/messaging/config.ts";

export const defaultDb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: process.env.DYNAMODB_REGION,
  }),
  {
    marshallOptions: {
      convertEmptyValues: true,
    },
  }
);

export type FameIndex = {
  block: number;
};

function fromDbToFameIndex(
  item?: Record<string, unknown> | null
): FameIndex | null {
  return item
    ? {
        block: Number(item.block),
      }
    : null;
}

export async function getLastIndexedBlock({
  chainId,
  db = defaultDb,
  tableName = DYNAMODB_FAME_INDEX_TABLE_NAME,
}: {
  chainId: number;
  db?: DynamoDBDocumentClient;
  tableName?: string;
}): Promise<FameIndex | null> {
  const response = await db.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        key: `${chainId}-last-block`,
      },
    })
  );
  return fromDbToFameIndex(response.Item);
}

export function setLastIndexedBlock({
  db = defaultDb,
  tableName = DYNAMODB_FAME_INDEX_TABLE_NAME,
  chainId,
  block,
}: {
  chainId: number;
  block: number;
  db?: DynamoDBDocumentClient;
  tableName?: string;
}) {
  return db.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        key: `${chainId}-last-block`,
        block,
      },
    })
  );
}
