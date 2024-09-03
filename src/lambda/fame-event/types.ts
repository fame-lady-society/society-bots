import { AbiEvent, BlockNumber, GetLogsReturnType } from "viem";

type PromiseType<T extends Promise<any>> = T extends Promise<infer U>
  ? U
  : never;

export type EventType<TAbiEvent extends AbiEvent> = PromiseType<
  Promise<
    GetLogsReturnType<
      TAbiEvent,
      [TAbiEvent],
      true,
      BlockNumber | undefined,
      BlockNumber | undefined
    >
  >
>[0];
