import { convertStringObjectToBigInt } from "../../../../utils/json.ts";

export const arbLogs1 = (
  [
    {
      address: "0x4200000000000000000000000000000000000006",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000003e2cab55bebf41719148b4e6b63f6644b18ae49c",
        "0x00000000000000000000000017cf46ed086ccef3c8abca349633f4546cea1916",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x00000000000000000000000000000000000000000000000002fba232bc000000",
      blockHash:
        "0x8da736d8a6c1766c015916ac46ed9d9e9c6cad53bb3957d16d37540d61e5b1d9",
      blockNumber: "bigint:17474558",
      transactionHash:
        "0xb29502bb8483aa95ccb02d4e5798eb90f8ee0b5188604caf4dee7f429c98d922",
      transactionIndex: 1,
      logIndex: 0,
      removed: false,
    },
    {
      address: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x000000000000000000000000eed3eff5775865229dcd0d7e0f6e89c611841202",
        "0x0000000000000000000000003e2cab55bebf41719148b4e6b63f6644b18ae49c",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x00000000000000000000000000000000000000000001ea208fb481dbde73a449",
      blockHash:
        "0x8da736d8a6c1766c015916ac46ed9d9e9c6cad53bb3957d16d37540d61e5b1d9",
      blockNumber: "bigint:17474558",
      transactionHash:
        "0xb29502bb8483aa95ccb02d4e5798eb90f8ee0b5188604caf4dee7f429c98d922",
      transactionIndex: 1,
      logIndex: 1,
      removed: false,
    },
    {
      address: "0x4200000000000000000000000000000000000006",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x00000000000000000000000017cf46ed086ccef3c8abca349633f4546cea1916",
        "0x000000000000000000000000eed3eff5775865229dcd0d7e0f6e89c611841202",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x00000000000000000000000000000000000000000000000002e2f6e5deb6a5c0",
      blockHash:
        "0x8da736d8a6c1766c015916ac46ed9d9e9c6cad53bb3957d16d37540d61e5b1d9",
      blockNumber: "bigint:17474558",
      transactionHash:
        "0xb29502bb8483aa95ccb02d4e5798eb90f8ee0b5188604caf4dee7f429c98d922",
      transactionIndex: 1,
      logIndex: 2,
      removed: false,
    },
    {
      address: "0xeed3eff5775865229dcd0d7e0f6e89c611841202",
      topics: [
        "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
        "0x00000000000000000000000017cf46ed086ccef3c8abca349633f4546cea1916",
        "0x0000000000000000000000003e2cab55bebf41719148b4e6b63f6644b18ae49c",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x00000000000000000000000000000000000000000000000002e2f6e5deb6a5c0fffffffffffffffffffffffffffffffffffffffffffe15df704b7e24218c5bb70000000000000000000000000000000000000cf35d977b0d5d106a636fa81e4d000000000000000000000000000000000000000000000995cc7f35d5c6f2ad630000000000000000000000000000000000000000000000000000000000027956",
      blockHash:
        "0x8da736d8a6c1766c015916ac46ed9d9e9c6cad53bb3957d16d37540d61e5b1d9",
      blockNumber: "bigint:17474558",
      transactionHash:
        "0xb29502bb8483aa95ccb02d4e5798eb90f8ee0b5188604caf4dee7f429c98d922",
      transactionIndex: 1,
      logIndex: 3,
      removed: false,
    },
    {
      address: "0x3e2cab55bebf41719148b4e6b63f6644b18ae49c",
      topics: [
        "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x00000000000000000000000000000000000000000000000080c34bd3cceb97e5000000000000000000000000000000000000000000544fac024de066b5e92c3b",
      blockHash:
        "0x8da736d8a6c1766c015916ac46ed9d9e9c6cad53bb3957d16d37540d61e5b1d9",
      blockNumber: "bigint:17474558",
      transactionHash:
        "0xb29502bb8483aa95ccb02d4e5798eb90f8ee0b5188604caf4dee7f429c98d922",
      transactionIndex: 1,
      logIndex: 4,
      removed: false,
    },
    {
      address: "0x3e2cab55bebf41719148b4e6b63f6644b18ae49c",
      topics: [
        "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
        "0x00000000000000000000000017cf46ed086ccef3c8abca349633f4546cea1916",
        "0x00000000000000000000000017cf46ed086ccef3c8abca349633f4546cea1916",
      ] as [] | [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001ea208fb481dbde73a44900000000000000000000000000000000000000000000000002fba232bc0000000000000000000000000000000000000000000000000000000000000000000000",
      blockHash:
        "0x8da736d8a6c1766c015916ac46ed9d9e9c6cad53bb3957d16d37540d61e5b1d9",
      blockNumber: "bigint:17474558",
      transactionHash:
        "0xb29502bb8483aa95ccb02d4e5798eb90f8ee0b5188604caf4dee7f429c98d922",
      transactionIndex: 1,
      logIndex: 5,
      removed: false,
    },
  ] as const
).map(convertStringObjectToBigInt);
