export const UniswapV2SyncEvent = {
  type: "event",
  anonymous: false,
  inputs: [
    {
      name: "reserve0",
      internalType: "uint112",
      type: "uint112",
      indexed: false,
    },
    {
      name: "reserve1",
      internalType: "uint112",
      type: "uint112",
      indexed: false,
    },
  ],
  name: "Sync",
} as const;

export const uniswapV2SwapEventAbi = {
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
      name: "amount0In",
      internalType: "uint256",
      type: "uint256",
      indexed: false,
    },
    {
      name: "amount1In",
      internalType: "uint256",
      type: "uint256",
      indexed: false,
    },
    {
      name: "amount0Out",
      internalType: "uint256",
      type: "uint256",
      indexed: false,
    },
    {
      name: "amount1Out",
      internalType: "uint256",
      type: "uint256",
      indexed: false,
    },
    { name: "to", internalType: "address", type: "address", indexed: true },
  ],
  name: "Swap",
} as const;

export const UniswapV3SwapEventAbi = {
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

export const ERC721TransferEventAbi = {
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

export const ERC20TransferEventAbi = {
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
      indexed: false,
      name: "value",
      type: "uint256",
    },
  ],
} as const;

export const uniswapV3SwapEventAbi = {
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
export const transferEvent = {
  type: "event",
  anonymous: false,
  inputs: [
    {
      name: "from",
      internalType: "address",
      type: "address",
      indexed: true,
    },
    { name: "to", internalType: "address", type: "address", indexed: true },
    {
      name: "tokenId",
      internalType: "uint256",
      type: "uint256",
      indexed: true,
    },
  ],
  name: "Transfer",
} as const;

export const metadataEvent = {
  type: "event",
  anonymous: false,
  inputs: [
    {
      name: "_tokenId",
      internalType: "uint256",
      type: "uint256",
      indexed: false,
    },
  ],
  name: "MetadataUpdate",
} as const;
