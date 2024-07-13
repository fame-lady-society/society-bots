import "dotenv/config";
import {
  AbiEvent,
  AbiEventSignatureNotFoundError,
  decodeEventLog,
  erc20Abi,
  erc721Abi,
  formatEther,
  parseUnits,
  zeroAddress,
} from "viem";
import { baseClient, mainnetClient, sepoliaClient } from "../../viem.js";
import type { ISwapWebhook } from "./types";
import { base } from "viem/chains";
import {
  chainlinkUsdcEthAbi,
  chainlinkUsdcEthAddress,
  uniswapV3PoolAbi,
} from "../../wagmi.generated.js";
import { Token, WETH9 } from "@uniswap/sdk-core";
import { FeeAmount, Pool } from "@uniswap/v3-sdk";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// const TOTAL_SUPPLY = parseUnits("888000000", 18);
const TOKEN_ADDRESS = "0xf307e242BfE1EC1fF01a4Cef2fdaa81b10A52418";
const TOKEN_WETH_V3_POOL = "0xeed3eff5775865229dcd0d7e0f6e89c611841202";
const TOKEN_LINKED_NFT_ADDRESS = "0xBB5ED04dD7B207592429eb8d599d103CCad646c4";
// const TOKEN_DECIMALS = 18;
const BASE_USDC_WETH_V3_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
const MAX_AMOUNT = parseUnits("1", 18);
const MIN_AMOUNT = parseUnits("0.001", 18);
const NFT_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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

export default async function handler({
  disableTelegram = false,
  destination,
  event,
}: {
  disableTelegram?: boolean;
  destination: number;
  event: ISwapWebhook["event"];
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
  for (const log of event.data.block.logs) {
    const {
      data,
      topics,
      transaction: {
        hash,
        from: { address: fromAddress },
      },
    } = log;
    try {
      const swapLog = decodeEventLog({
        abi: uniswapV3PoolAbi,
        data,
        topics,
      });
      if (swapLog.eventName === "Swap") {
        const recipient = fromAddress;
        const [wethUsdcPool, schwingWethPool, recipientBalance] =
          await Promise.all([
            createPoolFromTokens(
              new Token(base.id, BASE_USDC_WETH_V3_POOL, 6, "USDC", "USD Coin"),
              WETH9[base.id],
              FeeAmount.MEDIUM,
              BASE_USDC_WETH_V3_POOL
            ),
            createPoolFromTokens(
              new Token(base.id, TOKEN_ADDRESS, 18, "FAME", "Society"),
              WETH9[base.id],
              FeeAmount.MEDIUM,
              TOKEN_WETH_V3_POOL
            ),
            baseClient.readContract({
              abi: erc20Abi,
              address: TOKEN_ADDRESS,
              functionName: "balanceOf",
              args: [recipient],
            }),
          ]);
        console.log(wethUsdcPool.token0Price.toSignificant(8));
        console.log(schwingWethPool.token1Price.toSignificant(18));
        const priceUsd =
          Number(schwingWethPool.token1Price.toSignificant(18)) *
          Number(wethUsdcPool.token0Price.toSignificant(12));
        console.log(priceUsd.toExponential());
        console.log("recipient", recipient);
        console.log("Market cap", priceUsd * 888_000_000);
        console.log("recipient balance", formatEther(recipientBalance));
        console.log("tokens received", formatEther(-swapLog.args.amount1));

        if (swapLog.args.amount1 > 0) {
          continue;
        }
        const ensName = await mainnetClient.getEnsName({
          address: recipient,
        });
        const shortAddress =
          ensName ?? recipient.slice(0, 6) + "..." + recipient.slice(-4);

        const amount0Spent = trimToFourDecimalPlacesOrFewer(
          formatEther(swapLog.args.amount0)
        );
        const amount0SpentUsdc =
          Number(formatEther(swapLog.args.amount0)) * currentUsdPrice;
        const tokensReceived = -swapLog.args.amount1;
        const amount1Received = formatMoney(tokensReceived);

        let positionDelta = "??";
        if (recipientBalance >= tokensReceived) {
          // Assuming tokensReceived, recipientBalance are BigInts
          const precisionFactor = 10000n; // Increase precision by factor of 10000
          const percentageBase = 100n; // Base for percentage calculation

          // Calculate percentage with increased precision and convert back to a percentage format
          positionDelta = `+${
            (((tokensReceived * precisionFactor) /
              (recipientBalance - tokensReceived)) *
              percentageBase) /
            precisionFactor
          }%`;
        }
        console.log(-swapLog.args.amount1, MIN_AMOUNT, MAX_AMOUNT);

        // walk through the transaction logs looking for mint/burn events
        const mintEvents: {
          eventName: "Transfer";
          args: {
            from: `0x${string}`;
            to: `0x${string}`;
            tokenId: bigint;
          };
        }[] = [];
        const burnEvents: {
          eventName: "Transfer";
          args: {
            from: `0x${string}`;
            to: `0x${string}`;
            tokenId: bigint;
          };
        }[] = [];
        for (const transactionLog of log.transaction.logs) {
          if (
            transactionLog.account.address.toLowerCase() ===
              TOKEN_LINKED_NFT_ADDRESS.toLowerCase() &&
            transactionLog.topics[0] === NFT_TRANSFER_TOPIC
          ) {
            try {
              const transferLog = decodeEventLog({
                abi: erc721Abi,
                data: transactionLog.data,
                topics: transactionLog.topics,
              });
              if (transferLog.eventName === "Transfer") {
                if (
                  transferLog.args.from === zeroAddress &&
                  transferLog.args.to.toLowerCase() === recipient.toLowerCase()
                ) {
                  mintEvents.push(transferLog);
                } else if (
                  transferLog.args.to.toLowerCase() === zeroAddress &&
                  transferLog.args.from === recipient.toLowerCase()
                ) {
                  burnEvents.push(transferLog);
                }
              }
            } catch (e) {
              if (e instanceof AbiEventSignatureNotFoundError) {
                // ignore
                continue;
              }
              console.error(
                "Failed to process event log for topic: ${transactionLog.topics[0]}",
                e
              );
            }
          }
        }
        // mint/burn message TokenId: [0-3, 5]
        const formattedMintMessage = `[${generateTokenIdListString(
          mintEvents.map((m) => Number(m.args.tokenId))
        )}]`;
        const formattedBurnMessage = `[${generateTokenIdListString(
          burnEvents.map((b) => Number(b.args.tokenId))
        )}]`;
        const caption = `
      <b>Buy</b> $FAME
${
  fillGrid(swapLog.args.amount0, MIN_AMOUNT, MAX_AMOUNT, [
    "🟩",
    "🟨",
    "🟥",
  ])?.join("\n") ?? ""
}
🔀 Spent $${amount0SpentUsdc} <b>(${amount0Spent} ETH)</b>
🔀 Got <b>${amount1Received} FAME</b>
👤 <a href="${
          base.blockExplorers.default.url
        }/address/${recipient}">${shortAddress}</a> <a href="${
          base.blockExplorers.default.url
        }/tx/${hash}">TX</a>
🪙 Position ${positionDelta}
🏷 Price $${
          priceUsd > 0.001
            ? priceUsd.toLocaleString()
            : priceUsd.toExponential(3)
        }
💸 Market Cap $${Math.floor(priceUsd * 888_000_000).toLocaleString()}
${mintEvents.length > 0 ? `📈 Minted ${formattedMintMessage}\n` : ""}${
          burnEvents.length > 0 ? `📉 Burned ${formattedBurnMessage}\n` : ""
        }
     `;

        console.log("sending animation...");
        console.log(caption);
        if (!disableTelegram) {
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
          console.log(JSON.stringify(responseBody, null, 2));

          console.log("Animation sent");
        }
      }
    } catch (e) {
      if (e instanceof AbiEventSignatureNotFoundError) {
        console.log(`Ignoring topic ${topics[0]}`);
        // ignore
        continue;
      }
      console.error("unable to process event", e);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "ok" }),
  };
}
