export class WorkLimit extends Error {}
export class RangeLimit extends Error {}

export function isCapacityError(error: unknown): boolean {
  if (error instanceof WorkLimit || error instanceof RangeLimit) return true;
  return (
    error instanceof Error &&
    error.cause !== error &&
    error.cause !== undefined &&
    isCapacityError(error.cause)
  );
}
