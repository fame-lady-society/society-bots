import { readFileSync } from "node:fs";
import {
  famePoolStateRegistry,
  parseFamePoolStateRegistry,
} from "../fame-swap-pool-state/registry/index.ts";

// Historical coverage can include pools that have no approved executable quote
// route. Keep those additions out of the landing/swap service's authority set.
export const fameHistoryRegistry = parseFamePoolStateRegistry({
  ...famePoolStateRegistry,
  pools: [
    ...famePoolStateRegistry.pools,
    ...JSON.parse(
      readFileSync(new URL("./additional-pools.json", import.meta.url), "utf8"),
    ),
  ],
});
