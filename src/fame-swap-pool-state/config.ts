function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is not defined`);
  }
  return value;
}

function optionalIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export const FAME_POOL_STATE_TABLE_NAME = requiredEnv(
  "FAME_POOL_STATE_TABLE_NAME",
);

export const FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS = optionalIntegerEnv(
  "FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS",
  120,
);

export const FAME_POOL_STATE_MAX_BATCH_SIZE = optionalIntegerEnv(
  "FAME_POOL_STATE_MAX_BATCH_SIZE",
  64,
);

export const FAME_POOL_STATE_CONFIRMATION_BLOCKS = optionalIntegerEnv(
  "FAME_POOL_STATE_CONFIRMATION_BLOCKS",
  2,
);
