import { convertStringObjectToBigInt } from "../../../utils/json.ts";

export const swapWithNftMintLogs = (
  [
    {
      address: "0x4200000000000000000000000000000000000006",
      topics: [
        "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x00000000000000000000000000000000000000000000000004d642decbf2b376",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 218,
      removed: false,
    },
    {
      address: "0x4200000000000000000000000000000000000006",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
        "0x0000000000000000000000003e2cab55bebf41719148b4e6b63f6644b18ae49c",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x00000000000000000000000000000000000000000000000002683aaa60e47b2e",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 219,
      removed: false,
    },
    {
      address: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000003e2cab55bebf41719148b4e6b63f6644b18ae49c",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x000000000000000000000000000000000000000000018e0a10451ecd119f1531",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 220,
      removed: false,
    },
    {
      address: "0x3e2cab55bebf41719148b4e6b63f6644b18ae49c",
      topics: [
        "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x0000000000000000000000000000000000000000000000008290c60a47bfae960000000000000000000000000000000000000000005307b499132f1dd90834ca",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 221,
      removed: false,
    },
    {
      address: "0x3e2cab55bebf41719148b4e6b63f6644b18ae49c",
      topics: [
        "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x00000000000000000000000000000000000000000000000002683aaa60e47b2e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000018e0a10451ecd119f1531",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 222,
      removed: false,
    },
    {
      address: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x000000000000000000000000eed3eff5775865229dcd0d7e0f6e89c611841202",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x000000000000000000000000000000000000000000018e0a10451ecd116e0000",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 223,
      removed: false,
    },
    {
      address: "0x4200000000000000000000000000000000000006",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
        "0x000000000000000000000000eed3eff5775865229dcd0d7e0f6e89c611841202",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x0000000000000000000000000000000000000000000000000267df1da872e727",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 224,
      removed: false,
    },
    {
      address: "0xeed3eff5775865229dcd0d7e0f6e89c611841202",
      topics: [
        "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x0000000000000000000000000000000000000000000000000267df1da872e727fffffffffffffffffffffffffffffffffffffffffffe71f5efbae132ee9200000000000000000000000000000000000000000cc6ca783287fe39aabf06af0da200000000000000000000000000000000000000000000075372eed04d1d8b85830000000000000000000000000000000000000000000000000000000000027847",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 225,
      removed: false,
    },
    {
      address: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
        "0x0000000000000000000000005d64d14d2cf4fe5fe4e65b1c7e3d11e18d493091",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x0000000000000000000000000000000000000000000001fc3842bd1f071c0000",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 226,
      removed: false,
    },
    {
      address: "0xbb5ed04dd7b207592429eb8d599d103ccad646c4",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x000000000000000000000000f11ce547ff948a03570b20eac4a4d7b648693324",
        "0x00000000000000000000000000000000000000000000000000000000000000f1",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 227,
      removed: false,
    },
    {
      address: "0xbb5ed04dd7b207592429eb8d599d103ccad646c4",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x000000000000000000000000f11ce547ff948a03570b20eac4a4d7b648693324",
        "0x00000000000000000000000000000000000000000000000000000000000000cb",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 228,
      removed: false,
    },
    {
      address: "0xbb5ed04dd7b207592429eb8d599d103ccad646c4",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x000000000000000000000000f11ce547ff948a03570b20eac4a4d7b648693324",
        "0x0000000000000000000000000000000000000000000000000000000000000088",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 229,
      removed: false,
    },
    {
      address: "0xbb5ed04dd7b207592429eb8d599d103ccad646c4",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x000000000000000000000000f11ce547ff948a03570b20eac4a4d7b648693324",
        "0x00000000000000000000000000000000000000000000000000000000000000e8",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 230,
      removed: false,
    },
    {
      address: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
        "0x000000000000000000000000f11ce547ff948a03570b20eac4a4d7b648693324",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x000000000000000000000000000000000000000000031a17e847807b1bf11531",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 231,
      removed: false,
    },
    {
      address: "0x4200000000000000000000000000000000000006",
      topics: [
        "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65",
        "0x0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x00000000000000000000000000000000000000000000000000062916c29b5121",
      blockHash:
        "0xc314545e5771995b0bcf0b78257918097775265189bbfb880dda3a8bf45c1083",
      blockNumber: "bigint:17095765",
      transactionHash:
        "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9",
      transactionIndex: 56,
      logIndex: 232,
      removed: false,
    },
  ] as const
).map(convertStringObjectToBigInt);
