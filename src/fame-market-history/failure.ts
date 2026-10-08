import { RangeLimit, WorkLimit } from "./limits.ts";
/** Return only fixed labels, never an SDK message, URL, or request body. */
export function failureCode(error: unknown): string {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof RangeLimit) return "rpc-response-limit";
    if (current.message.includes("Single block"))
      return "single-block-capacity";
    if (current instanceof WorkLimit) return "work-limit";
    if (
      current.message.includes("allowance") ||
      current.message.includes("deadline")
    )
      return "work-limit";
    if (
      current.message.includes("boundary hash") ||
      current.message.includes("Finalized head regressed") ||
      current.message.includes("Range changed") ||
      current.message.includes("parent hash")
    )
      return "canonical-conflict";
    if (current.message.includes("chain mismatch")) return "wrong-chain";
    if (current.message.includes("verification failed"))
      return "archive-verification-failed";
    if (current.name === "TransactionCanceledException")
      return "publication-rejected";
    if (current.message.startsWith("History RPC")) return "rpc-failure";
    current = "cause" in current ? current.cause : undefined;
  }
  return "collection-failed";
}
