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

function optionalPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = optionalIntegerEnv(name, fallback);
  if (parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function optionalBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function optionalStringEnumEnv<const T extends readonly string[]>(
  name: string,
  values: T,
  fallback: T[number],
): T[number] {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return fallback;
  if (values.includes(value)) return value;
  throw new Error(`${name} must be one of ${values.join(", ")}`);
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

export const FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE = optionalStringEnumEnv(
  "FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE",
  ["checkpoint", "steady-state", "repair"] as const,
  "steady-state",
);

export const FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION = optionalBooleanEnv(
  "FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION",
  true,
);

export const FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS = optionalIntegerEnv(
  "FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS",
  1_000,
);

export const FAME_POOL_STATE_RPC_GET_LOGS_BLOCK_RANGE =
  optionalPositiveIntegerEnv("FAME_POOL_STATE_RPC_GET_LOGS_BLOCK_RANGE", 500);
