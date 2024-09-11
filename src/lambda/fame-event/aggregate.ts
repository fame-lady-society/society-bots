import "dotenv/config";
import {
  AbiEvent,
  AbiEventSignatureNotFoundError,
  DecodeLogTopicsMismatch,
  decodeEventLog,
  erc20Abi,
  erc721Abi,
  formatEther,
  parseUnits,
  zeroAddress,
} from "viem";
import { baseClient, mainnetClient, sepoliaClient } from "../../viem.ts";
import { base } from "viem/chains";
import {
  chainlinkUsdcEthAbi,
  chainlinkUsdcEthAddress,
  uniswapV3PoolAbi,
  uniswapV2PoolAbi,
} from "../../wagmi.generated.ts";
import { Token, WETH9 } from "@uniswap/sdk-core";
import { FeeAmount, Pool } from "@uniswap/v3-sdk";
import {
  BASE_FAME_ADDRESS,
  BASE_FAME_NFT_ADDRESS,
  BASE_FAME_WETH_V2_POOL,
  BASE_FAME_WETH_V3_POOL,
} from "../../constants.ts";
import { CompleteSwapEvent } from "@/webhook/swap/types.ts";
import { bigIntToStringJsonFormat } from "../../utils/json.ts";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// const TOTAL_SUPPLY = parseUnits("888000000", 18);
const TOKEN_ADDRESS = BASE_FAME_ADDRESS;
/* v3 Pool info:
 * token0: WETH
 * token1: FAME
 * */
const TOKEN_WETH_V3_POOL = BASE_FAME_WETH_V3_POOL;
/* v3 Pool info:
 * token0: WETH
 * token1: FAME
 * */
const TOKEN_WETH_V2_POOL = BASE_FAME_WETH_V2_POOL;
const TOKEN_LINKED_NFT_ADDRESS = BASE_FAME_NFT_ADDRESS;

function addressToAbi(address: `0x${string}`) {
  switch (address.toLowerCase()) {
    case TOKEN_WETH_V2_POOL.toLowerCase():
      return uniswapV2PoolAbi;
    case TOKEN_WETH_V3_POOL.toLowerCase():
      return uniswapV3PoolAbi;
    case TOKEN_LINKED_NFT_ADDRESS.toLowerCase():
      return erc721Abi;
    case TOKEN_ADDRESS.toLowerCase():
    case WETH9[base.id].address.toLowerCase():
      return erc20Abi;
  }
}

const UniswapV3SwapEventAbi = {
  type: "event",
  anonymous: false,
  inputs: [
    {
      name: "sender",
      internalType: "address",
      type: "address",
      indexed: true,
    },
    {
      name: "recipient",
      internalType: "address",
      type: "address",
      indexed: true,
    },
    {
      name: "amount0",
      internalType: "int256",
      type: "int256",
      indexed: false,
    },
    {
      name: "amount1",
      internalType: "int256",
      type: "int256",
      indexed: false,
    },
    {
      name: "sqrtPriceX96",
      internalType: "uint160",
      type: "uint160",
      indexed: false,
    },
    {
      name: "liquidity",
      internalType: "uint128",
      type: "uint128",
      indexed: false,
    },
    { name: "tick", internalType: "int24", type: "int24", indexed: false },
  ],
  name: "Swap",
} as const;

const TransferEventAbi = {
  type: "event",
  name: "Transfer",
  inputs: [
    {
      indexed: true,
      name: "from",
      type: "address",
    },
    {
      indexed: true,
      name: "to",
      type: "address",
    },
    {
      indexed: true,
      name: "tokenId",
      type: "uint256",
    },
  ],
} as const;

async function findEvents<E extends AbiEvent>(
  client: typeof sepoliaClient | typeof mainnetClient | typeof baseClient,
  contractAddress: `0x${string}`,
  event: E,
  fromBlock: bigint,
  toBlock: bigint
) {
  const events = await client.getLogs({
    address: contractAddress,
    fromBlock,
    toBlock,
    event,
  });

  return events.map((event) => {
    return {
      ...event,
      blockNumber: event.blockNumber,
    };
  });
}

export const formatMoney = (amount: bigint) =>
  `${Number(formatEther(amount).split(".")[0])
    .toLocaleString("en")
    .replaceAll(",", " ")}`;

function trimToFourDecimalPlacesOrFewer(numberString: string): string {
  const decimalIndex = numberString.indexOf(".");
  if (decimalIndex === -1) {
    // No decimal point found, return the original string
    return numberString;
  }

  const decimals = numberString.slice(decimalIndex + 1);
  const nonZeroIndex = decimals.search(/[^0]/); // Find first non-zero digit after decimal

  // Calculate the number of characters to keep after the decimal point
  // If there are no non-zero digits, or all non-zero digits are within the first 4, trim to 4
  // Otherwise, trim to the position of the first non-zero digit + 4
  const charsAfterDecimal =
    nonZeroIndex === -1 || nonZeroIndex > 3 ? 4 : nonZeroIndex + 4;

  return numberString.slice(0, decimalIndex + 1 + charsAfterDecimal);
}

function formatPrice(price: bigint, decimals: number) {
  // Convert the price to a string
  const priceString = price.toString();

  // Add decimal point at the correct position
  const integerPart =
    priceString.slice(0, priceString.length - decimals) || "0";
  const decimalPart = priceString
    .slice(priceString.length - decimals)
    .padStart(decimals, "0");

  return `${integerPart}.${decimalPart}`;
}

// Define a function to create a Pool object from two tokens
async function createPoolFromTokens(
  tokenA: Token,
  tokenB: Token,
  feeAmount: FeeAmount,
  contractAddress: `0x${string}`
) {
  const [[afterPrice, tickCurrent], liquidity] = await Promise.all([
    baseClient.readContract({
      abi: uniswapV3PoolAbi,
      address: contractAddress,
      functionName: "slot0",
    }),
    baseClient.readContract({
      abi: uniswapV3PoolAbi,
      address: contractAddress,
      functionName: "liquidity",
    }),
  ]);

  return new Pool(
    tokenA,
    tokenB,
    feeAmount,
    afterPrice.toString(),
    liquidity.toString(),
    tickCurrent
  );
}

function generateTokenIdListString(tokenIds: number[]): string {
  // Sort the token IDs to ensure they are in ascending order
  tokenIds.sort((a, b) => a - b);

  const ranges: string[] = [];
  let rangeStart = tokenIds[0];
  let rangeEnd = tokenIds[0];

  for (let i = 1; i <= tokenIds.length; i++) {
    // Check if the current token ID is consecutive to the previous one
    if (tokenIds[i] === rangeEnd + 1) {
      rangeEnd = tokenIds[i];
    } else {
      // If the start and end of the range are the same, add it as a single number
      if (rangeStart === rangeEnd) {
        ranges.push(`${rangeStart}`);
      } else {
        ranges.push(`${rangeStart}-${rangeEnd}`);
      }
      // Start a new range
      rangeStart = tokenIds[i];
      rangeEnd = tokenIds[i];
    }
  }

  // Join the ranges array into a string with commas separating the ranges
  return ranges.join(", ");
}

const TEXT_WIDTH = 10n;
const MAX_HEIGHT = 10n;

function fillGrid(amount: bigint, min: bigint, max: bigint, emojis: string[]) {
  if (emojis.length === 0) {
    throw new Error("Emojis array must have one or more characters.");
  }

  if (amount < min) {
    return null;
  }

  const totalCells = Number(TEXT_WIDTH * MAX_HEIGHT);
  const totalRange = max - min;

  // Apply easing formula: Adjust the amount using a quadratic progression
  // Assuming min, max, and amount are already defined BigInts
  // Convert BigInts to Numbers for the easing calculation
  const numMin = Number(min);
  const numMax = Number(max);
  const numAmount = Number(amount);

  // Calculate the normalized position of amount between min and max
  const normalizedAmount = (numAmount - numMin) / (numMax - numMin);

  // Apply a cubic easing function for a quick start and a smooth approach to max
  // Adjust the exponent as needed to control the easing effect
  const eased = numMin + (numMax - numMin) * Math.pow(normalizedAmount, 0.3);

  // Ensure eased is always greater than amount by checking if it's not, then set it to amount + a small increment
  // This increment can be adjusted based on how quickly you want to ease out from the amount
  const finalEased = Math.max(eased, numAmount + (numMax - numMin) * 0.01);

  // Clamp the result to ensure it doesn't exceed max
  const clampedEased = Math.max(numMin, Math.min(finalEased, numMax));

  // Convert the result back to BigInt
  const easedAmount = BigInt(Math.floor(clampedEased));

  // Ensure easedAmount is between min and max and greater than amount
  console.log(
    `Amount: ${formatEther(amount)} Eased Amount: ${formatEther(
      easedAmount
    )}, Min: ${formatEther(min)}, Max: ${formatEther(max)}`
  );
  const segmentSize = totalRange / BigInt(emojis.length);
  const segmentIndex = Number((easedAmount - min) / segmentSize);
  const segmentSubIndex =
    Number((easedAmount - min) % segmentSize) / Number(segmentSize);

  const numberOfElementsFilled = Math.floor(segmentSubIndex * totalCells);

  let grids: string[] = [];

  const fillRows = (emoji: string, count: number) => {
    let fillCount = 0;
    while (fillCount + Number(TEXT_WIDTH) <= count) {
      const row = Array.from({ length: Number(TEXT_WIDTH) }, () => emoji);
      grids.push(row.join(""));
      fillCount += Number(TEXT_WIDTH);
    }
    return fillCount;
  };

  if (easedAmount >= max) {
    fillRows(emojis[emojis.length - 1], totalCells);
    return grids;
  }

  fillRows(emojis[segmentIndex], numberOfElementsFilled);

  if (numberOfElementsFilled % Number(TEXT_WIDTH) > 0) {
    const remainingCells = numberOfElementsFilled % Number(TEXT_WIDTH);
    const partialRow = Array.from({ length: Number(TEXT_WIDTH) }, (_, i) =>
      i < remainingCells
        ? emojis[segmentIndex]
        : segmentIndex === 0
        ? ""
        : emojis[segmentIndex - 1]
    );
    grids.push(partialRow.join(""));
  }

  if (segmentIndex > 0) {
    const remainingCount = totalCells - numberOfElementsFilled;
    fillRows(emojis[segmentIndex - 1], remainingCount);
  }

  return grids;
}

async function sendMessage({
  amount0SpentUsdc,
  amount0Spent,
  amount1Received,
  grid,
  destination,
  recipient,
  shortAddress,
  hash,
  positionDelta,
  priceUsd,
  formattedMintMessage,
  formattedBurnMessage,
  mintEvents,
  burnEvents,
}: {
  amount0SpentUsdc: number;
  amount0Spent: string;
  amount1Received: string;
  grid: string[] | null;
  destination: number;
  recipient: `0x${string}`;
  shortAddress: string;
  hash: `0x${string}`;
  positionDelta: string;
  priceUsd: number;
  formattedMintMessage: string;
  formattedBurnMessage: string;
  mintEvents: {
    eventName: "Transfer";
    args: {
      from: `0x${string}`;
      to: `0x${string}`;
      tokenId: bigint;
    };
  }[];
  burnEvents: {
    eventName: "Transfer";
    args: {
      from: `0x${string}`;
      to: `0x${string}`;
      tokenId: bigint;
    };
  }[];
}) {
  const caption = `
  <b>Buy</b> $FAME
${grid?.join("\n") ?? ""}
🔀 Spent $${amount0SpentUsdc} <b>(${amount0Spent} ETH)</b>
🔀 Got <b>${amount1Received} FAME</b>
👤 <a href="${
    base.blockExplorers.default.url
  }/address/${recipient}">${shortAddress}</a> <a href="${
    base.blockExplorers.default.url
  }/tx/${hash}">TX</a>
🪙 Position ${positionDelta}
🏷 Price $${
    priceUsd > 0.001 ? priceUsd.toLocaleString() : priceUsd.toExponential(3)
  }
💸 Market Cap $${Math.floor(priceUsd * 888_000_000).toLocaleString()}
${mintEvents.length > 0 ? `📈 Minted ${formattedMintMessage}\n` : ""}${
    burnEvents.length > 0 ? `📉 Burned ${formattedBurnMessage}\n` : ""
  }
 `;

  console.log("sending animation...");
  console.log(caption);
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAnimation`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: destination,
        animation:
          "https://images-ext-1.discordapp.net/external/1rMxR_ORQ4JQ4AWNkGYEHA0NvK_f6xv84tmrOU3QDz0/https/media.tenor.com/Sznlx6WCcFkAAAPo/dance-iggy-pop-iggy.mp4",
        parse_mode: "HTML",
        caption,
      }),
    }
  );
  const responseBody = await response.json();
  console.log("Animation sent");
}

function updateBalanceDeltaFromV2SwapEvent(
  wethBalanceDelta: Map<`0x${string}`, bigint>,
  tokenBalanceDelta: Map<`0x${string}`, bigint>,
  v2SwapEvent: CompleteSwapEvent["v2SwapEvents"][0]
) {
  const sender = v2SwapEvent.sender.toLowerCase() as `0x${string}`;
  const to = v2SwapEvent.to.toLowerCase() as `0x${string}`;
  wethBalanceDelta.set(
    sender,
    (wethBalanceDelta.get(sender) ?? 0n) - v2SwapEvent.amount0In
  );
  wethBalanceDelta.set(
    to,
    (wethBalanceDelta.get(to) ?? 0n) + v2SwapEvent.amount0Out
  );
  tokenBalanceDelta.set(
    sender,
    (tokenBalanceDelta.get(sender) ?? 0n) - v2SwapEvent.amount1In
  );
  tokenBalanceDelta.set(
    to,
    (tokenBalanceDelta.get(to) ?? 0n) + v2SwapEvent.amount1Out
  );
}

function updateBalanceDeltaFromV3SwapEvent(
  wethBalanceDelta: Map<`0x${string}`, bigint>,
  tokenBalanceDelta: Map<`0x${string}`, bigint>,
  v3SwapEvent: CompleteSwapEvent["v3SwapEvents"][0]
) {
  const sender = v3SwapEvent.sender.toLowerCase() as `0x${string}`;
  const recipient = v3SwapEvent.recipient.toLowerCase() as `0x${string}`;
  wethBalanceDelta.set(
    sender,
    (wethBalanceDelta.get(sender) ?? 0n) - v3SwapEvent.amount0
  );
  wethBalanceDelta.set(
    recipient,
    (wethBalanceDelta.get(recipient) ?? 0n) + v3SwapEvent.amount0
  );
  tokenBalanceDelta.set(
    sender,
    (tokenBalanceDelta.get(sender) ?? 0n) - v3SwapEvent.amount1
  );
  tokenBalanceDelta.set(
    recipient,
    (tokenBalanceDelta.get(recipient) ?? 0n) + v3SwapEvent.amount1
  );
}

export async function aggregateLogs({
  logs,
}: {
  logs: {
    address: `0x${string}`; // contract address
    data: `0x${string}`;
    topics: [] | [signature: `0x${string}`, ...args: `0x${string}`[]];
  }[];
}) {
  const currentUsdPrice = Number(
    formatPrice(
      await baseClient.readContract({
        abi: chainlinkUsdcEthAbi,
        address: chainlinkUsdcEthAddress[base.id],
        functionName: "latestAnswer",
      }),
      8
    )
  );
  const recipientMap = new Map<`0x${string}`, CompleteSwapEvent>();
  function getOrCreateRecipient(recipient: `0x${string}`) {
    recipient = recipient.toLowerCase() as `0x${string}`;
    if (recipientMap.has(recipient)) {
      return recipientMap.get(recipient)!;
    }
    const r = {
      burnEvents: [],
      mintEvents: [],
      v2SwapEvents: [],
      v3SwapEvents: [],
      syncEvents: [],
      token0TransferEvents: [],
      token1TransferEvents: [],
    };
    recipientMap.set(recipient, r);
    return r;
  }
  const decodedLogs: unknown[] = [];
  for (const log of logs) {
    const { data, topics } = log;
    let { address } = log;
    address = address.toLowerCase() as `0x${string}`;
    const abi = addressToAbi(address);
    if (!abi) {
      continue;
    }
    try {
      const decodedEvent = decodeEventLog({
        abi,
        data,
        topics,
        strict: true,
      });
      decodedLogs.push(decodedEvent);
      switch (decodedEvent.eventName) {
        case "Swap": {
          if (
            address === TOKEN_WETH_V3_POOL.toLowerCase() &&
            "recipient" in decodedEvent.args
          ) {
            const recipient = decodedEvent.args.recipient;
            const swapEvent = getOrCreateRecipient(recipient);
            swapEvent.v3SwapEvents.push(decodedEvent.args);
          } else if (
            address === TOKEN_WETH_V2_POOL.toLowerCase() &&
            "to" in decodedEvent.args
          ) {
            const recipient = decodedEvent.args.to;
            const swapEvent = getOrCreateRecipient(recipient);
            swapEvent.v2SwapEvents.push(decodedEvent.args);
          }
          continue;
        }
        case "Transfer": {
          if (
            address === TOKEN_LINKED_NFT_ADDRESS.toLowerCase() &&
            "tokenId" in decodedEvent.args
          ) {
            if (decodedEvent.args.from === zeroAddress) {
              const recipient = decodedEvent.args.to;
              const swapEvent = getOrCreateRecipient(recipient);
              swapEvent.mintEvents.push(decodedEvent.args);
            } else if (decodedEvent.args.to === zeroAddress) {
              const recipient = decodedEvent.args.from;
              const swapEvent = getOrCreateRecipient(recipient);
              swapEvent.burnEvents.push(decodedEvent.args);
            }
          } else if (
            address === TOKEN_ADDRESS.toLowerCase() &&
            "value" in decodedEvent.args
          ) {
            const recipient = decodedEvent.args.to;
            const swapEvent = getOrCreateRecipient(recipient);
            swapEvent.token1TransferEvents.push(decodedEvent.args);
          } else if (
            address === WETH9[base.id].address.toLowerCase() &&
            "value" in decodedEvent.args
          ) {
            const recipient = decodedEvent.args.to;
            const swapEvent = getOrCreateRecipient(recipient);
            swapEvent.token0TransferEvents.push(decodedEvent.args);
          }
          continue;
        }
        case "Sync": {
          if (address === TOKEN_WETH_V2_POOL.toLowerCase()) {
            const swapEvent = getOrCreateRecipient(address);
            swapEvent.syncEvents.push(decodedEvent.args);
          }
          continue;
        }
      }
    } catch (e) {
      if (ignorableDecodeError(e)) {
        // nothing
      } else {
        console.error("unable to process event", e);
      }
    }
  }
  return {
    recipientMap,
    currentUsdPrice,
  };
}

function ignorableDecodeError(e: unknown) {
  return (
    e instanceof AbiEventSignatureNotFoundError ||
    e instanceof DecodeLogTopicsMismatch
  );
}

export function aggregateSwapEvents({
  recipientMap,
  value,
  from: txFrom,
  to: txTo,
}: {
  recipientMap: Map<`0x${string}`, CompleteSwapEvent>;
  value: bigint;
  from: `0x${string}`;
  to: `0x${string}`;
}) {
  let isArb = false;

  const nftsMinted: bigint[] = [];
  const nftsBurned: bigint[] = [];

  const wethBalanceDelta = new Map<`0x${string}`, bigint>();
  const tokenBalanceDelta = new Map<`0x${string}`, bigint>();

  const v2SwapEventRecipient = recipientMap.get(
    BASE_FAME_WETH_V2_POOL.toLowerCase() as `0x${string}`
  );
  const v3SwapEventRecipient = recipientMap.get(
    BASE_FAME_WETH_V3_POOL.toLowerCase() as `0x${string}`
  );

  if (v2SwapEventRecipient || v3SwapEventRecipient) {
    isArb = true;
  }

  for (const recipient of recipientMap.values()) {
    for (const token0TransferEvent of recipient.token0TransferEvents) {
      let { to, from } = token0TransferEvent;
      to = to.toLowerCase() as `0x${string}`;
      from = from.toLowerCase() as `0x${string}`;
      const { value } = token0TransferEvent;
      wethBalanceDelta.set(to, (wethBalanceDelta.get(to) ?? 0n) + value);
      wethBalanceDelta.set(from, (wethBalanceDelta.get(from) ?? 0n) - value);
    }

    for (const token1TransferEvent of recipient.token1TransferEvents) {
      let { to, from } = token1TransferEvent;
      to = to.toLowerCase() as `0x${string}`;
      from = from.toLowerCase() as `0x${string}`;
      const { value } = token1TransferEvent;
      tokenBalanceDelta.set(to, (tokenBalanceDelta.get(to) ?? 0n) + value);
      tokenBalanceDelta.set(from, (tokenBalanceDelta.get(from) ?? 0n) - value);
    }

    for (const mintEvent of recipient.mintEvents) {
      nftsMinted.push(mintEvent.tokenId);
    }

    for (const burnEvent of recipient.burnEvents) {
      nftsBurned.push(burnEvent.tokenId);
    }
  }

  // if there is any value, create a fake weth transfer event
  if (value > 0n) {
    txTo = txTo.toLowerCase() as `0x${string}`;
    txFrom = txFrom.toLowerCase() as `0x${string}`;
    const fakeWethTransferEvent = {
      to: txTo,
      from: txFrom,
      value,
    };
    wethBalanceDelta.set(txTo, (wethBalanceDelta.get(txTo) ?? 0n) + value);
    wethBalanceDelta.set(txFrom, (wethBalanceDelta.get(txFrom) ?? 0n) - value);
  }

  return {
    isArb,
    nftsMinted,
    nftsBurned,
    wethBalanceDelta,
    tokenBalanceDelta,
  };
}

export type AggregateSwapEvents = ReturnType<typeof aggregateSwapEvents>;
