import { AggregateSwapEvents } from "./handler";

export function aggregateSwapEventHelper(event: AggregateSwapEvents) {
  
  const self = {
    event,
    netFameTransferred: event.tokenBalanceDelta.reduce(
      (acc, { delta }) => acc + delta,
      0
    ),
  };

  return self;
}
