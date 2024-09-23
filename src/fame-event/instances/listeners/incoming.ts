/*
 * We get v2 and v3 events in two different callbacks, so we are going to
 * wait 100ms to see if we get more events, and then aggregate them.
 */

import { V2LogEvent, V3LogEvent } from "./types.ts";

const throttle = (fn: () => void, wait: number) => {
  let timeout: NodeJS.Timeout | undefined;
  return () => {
    if (timeout) return;
    timeout = setTimeout(() => {
      fn();
      timeout = undefined;
    }, wait);
  };
};

export function createIncomingLogListener(
  callback: ({
    v2Logs,
    v3Logs,
  }: {
    v2Logs: V2LogEvent[];
    v3Logs: V3LogEvent[];
  }) => void
) {
  let v2Logs: V2LogEvent[] = [];
  let v3Logs: V3LogEvent[] = [];

  const throttledLogProcessor = throttle(() => {
    callback({ v2Logs, v3Logs });
    v2Logs = [];
    v3Logs = [];
  }, 100);

  return {
    onV2Logs: (logs: V2LogEvent) => {
      v2Logs.push(logs);
      throttledLogProcessor();
    },
    onV3Logs: (logs: V3LogEvent) => {
      v3Logs.push(logs);
      throttledLogProcessor();
    },
  };
}
