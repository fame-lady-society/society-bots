import "dotenv/config";
import { baseClient } from "./viem.js";
import {
  uniswapV3PoolAbi,
  chainlinkUsdcEthAbi,
  chainlinkUsdcEthAddress,
} from "./wagmi.generated.js";
import { base } from "viem/chains";
// @ts-ignore
import cu from "@thanpolas/crypto-utils";
import { Price, Token, WETH9 } from "@uniswap/sdk-core";
import { FeeAmount, Pool } from "@uniswap/v3-sdk";
import { formatUnits, parseUnits } from "viem";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_USDC_WETH_V3_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
const SCHWING_WETH_V3_POOL = "0x04b41Fe46e8685719Ac40101fc6478682256Bc6F";

// Calculate price from sqrtPriceX9

// Function to format the price with proper decimals
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
// calculate the exponent for the given decimals number.
function expDecs(decimals: bigint) {
  return 10n ** decimals;
}

const Q96 = 2n ** 96n;
const Q192 = Q96 ** 2n;

function calculatePriceFromSqrtPriceX96(
  token0Decimals: bigint,
  token1Decimals: bigint,
  sqrtRatioX96: bigint
) {
  const scalarNumerator = expDecs(token0Decimals);
  const scalarDenominator = expDecs(token1Decimals);

  const inputNumerator = sqrtRatioX96 * sqrtRatioX96;
  const inputDenominator = Q192;

  const adjustedForDecimalsNumerator = scalarDenominator * inputDenominator;

  const adjustedForDecimalsDenominator = scalarNumerator * inputNumerator;

  const numerator = adjustedForDecimalsNumerator;
  const denominator = adjustedForDecimalsDenominator;

  return [numerator, denominator] as const;
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
  const segmentSize = totalRange / BigInt(emojis.length);

  const segmentIndex = Number((amount - min) / segmentSize);
  const segmentSubIndex =
    Number((amount - min) % segmentSize) / Number(segmentSize);

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

  if (amount >= max) {
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

async function interactive() {
  const wethUsdcPool = await createPoolFromTokens(
    WETH9[base.id],
    new Token(base.id, BASE_USDC_WETH_V3_POOL, 6, "USDC", "USD Coin"),
    FeeAmount.MEDIUM,
    BASE_USDC_WETH_V3_POOL
  );
  const schwingWethPool = await createPoolFromTokens(
    WETH9[base.id],
    new Token(base.id, SCHWING_WETH_V3_POOL, 18, "SCHWING", "SCHWING"),
    FeeAmount.MEDIUM,
    SCHWING_WETH_V3_POOL
  );
  console.log(wethUsdcPool.token0Price.toSignificant(8));
  console.log(schwingWethPool.token1Price.toSignificant(18));
  const priceUsd =
    Number(schwingWethPool.token1Price.toSignificant(18)) *
    Number(wethUsdcPool.token0Price.toSignificant(12));
  console.log(priceUsd);

  console.log("Market cap", priceUsd * 888_000_000);

  const max = parseUnits("1", 18);
  const min = parseUnits("0.01", 18);
  for (let amount = 0n; amount <= max; amount += max / 10n) {
    console.log(`Amount: ${formatUnits(amount, 18)}
-----------------`);
    console.log(fillGrid(amount, min, max, ["🟩", "🟨", "🟥"])?.join("\n"));
    console.log("-----------------");
  }

  // console.log(formatPrice(calculatePriceFromSqrtPriceX96(afterPrice), 6));

  //   const response = await fetch(
  //     `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAnimation`,
  //     {
  //       method: "POST",
  //       headers: {
  //         "Content-Type": "application/json",
  //       },
  //       body: JSON.stringify({
  //         chat_id: 5835157950,
  //         // chat_id: -1002124583878,
  //         animation: "https://media.giphy.com/media/3o7TKz4DByZb7bK0kA/giphy.gif",
  //         parse_mode: "HTML",
  //         caption: `
  // 💃💃💃💃💃💃💃💃
  // 💃💃💃💃💃💃💃💃
  // 💃💃💃💃💃💃💃💃
  // 🔀 Spent <b>$999.26 (0.327 ETH)</b>
  // 🔀 Got <b>14,761 FAME</b>
  // 👤 <a href="https://etherscan.io/address/0x271271e6c59d4e47d67cd7ac13f8d0232fa4c919">nftcaptain.eth</a> <a href="https://etherscan.io/tx/0x52da688f5338e3878e7cf342f0cb75c5ba26db4f38688fb8f2e5b0e859c31fa0">TX</a>
  // 🪙 Position +37%
  // 🏷 Price $0.0671
  // 💸 Market Cap $33,571,157
  // `,
  //       }),
  //     }
  //   );
  //   console.log(JSON.stringify(await response.json(), null, 2));
}

async function getUpdates() {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`
  );
  console.log(JSON.stringify(await response.json(), null, 2));
}

interactive().catch(console.error);

// import { TelegramClient, sessions } from "telegram";
// import readline from "readline";
// const { StringSession } = sessions;

// const stringSession = new StringSession(process.env.TG_SESSION ?? ""); // fill this later with the value from session.save()

// const rl = readline.createInterface({
//   input: process.stdin,
//   output: process.stdout,
// });

// const promiseAppId = () =>
//   new Promise<string>((resolve) => {
//     rl.question("Please enter your API ID: ", resolve);
//   });
// const promiseApiHash = () =>
//   new Promise<string>((resolve) => {
//     rl.question("Please enter your API hash: ", resolve);
//   });

// (async () => {
//   console.log("Loading interactive example...");
//   const apiId = parseInt(await promiseAppId());
//   const apiHash = await promiseApiHash();
//   const client = new TelegramClient(stringSession, apiId, apiHash, {
//     connectionRetries: 5,
//   });
//   await client.start({
//     phoneNumber: async () =>
//       new Promise((resolve) =>
//         rl.question("Please enter your number: ", resolve)
//       ),
//     password: async () =>
//       new Promise((resolve) =>
//         rl.question("Please enter your password: ", resolve)
//       ),
//     phoneCode: async () =>
//       new Promise((resolve) =>
//         rl.question("Please enter the code you received: ", resolve)
//       ),
//     onError: (err) => console.log(err),
//   });
//   console.log("You should now be connected.");
//   console.log(client.session.save()); // Save this string to avoid logging in again
//   await client.sendMessage("flick_the_dev", { message: "Hello!" });
// })();
