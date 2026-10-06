import {
  GetParameterCommand,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import {
  CHAIN_ID,
  hash,
  integer,
  record,
  type Header,
} from "../../src/fame-market-history/model.ts";

export const START_PARAMETER = "/society-bots/market-history/start";
export interface StartMarker {
  version: 1;
  chainId: typeof CHAIN_ID;
  block: Header;
  selectedAt: number;
}
function parse(value: string | undefined): StartMarker {
  const marker = record(JSON.parse(value ?? "null"));
  if (marker.version !== 1 || marker.chainId !== CHAIN_ID)
    throw new Error("Invalid history start marker");
  const block = record(marker.block);
  return {
    version: 1,
    chainId: CHAIN_ID,
    selectedAt: integer(marker.selectedAt, "selection timestamp", 1),
    block: {
      number: integer(block.number, "start block", 1),
      hash: hash(block.hash),
      parentHash: hash(block.parentHash),
      timestamp: integer(block.timestamp, "block timestamp", 1),
    },
  };
}
/** Persist once outside the stack so retries, updates and stack replacement
 * cannot silently choose a newer boundary. Only an absent parameter initializes. */
export async function historyStart(
  ssm: SSMClient,
  finalized: () => Promise<Header>,
  now = Date.now,
): Promise<StartMarker> {
  const read = async () =>
    parse(
      (await ssm.send(new GetParameterCommand({ Name: START_PARAMETER })))
        .Parameter?.Value,
    );
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ParameterNotFound")
      throw error;
  }
  const marker = parse(
    JSON.stringify({
      version: 1,
      chainId: CHAIN_ID,
      block: await finalized(),
      selectedAt: now(),
    }),
  );
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: START_PARAMETER,
        Type: "String",
        Value: JSON.stringify(marker),
        Overwrite: false,
        Description:
          "Immutable initial finalized Base block for FAME market history; retain across deployments.",
      }),
    );
    return marker;
  } catch (error) {
    // Another initializer or an earlier successful write with a lost response
    // owns the boundary. Never overwrite it with this attempt's newer head.
    if (!(error instanceof Error) || error.name !== "ParameterAlreadyExists")
      throw error;
    return read();
  }
}
