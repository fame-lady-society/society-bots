import { QueryClient, QueryCache, MutationCache } from "@tanstack/react-query";
import { AuthorityError } from "./api";
export function createDataClient(onAuthorityDenied: () => void) {
  let notified = false;
  const onError = (error: Error) => {
    if (error instanceof AuthorityError && !notified) {
      notified = true;
      client.clear();
      onAuthorityDenied();
    }
  };
  const client = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
  });
  return client;
}
