if (!process.env.CORS_ALLOWED_ORIGINS_JSON) {
  throw new Error("CORS_ALLOWED_ORIGINS_JSON is not defined");
}
export const CORS_ALLOWED_ORIGINS_JSON =
  process.env.CORS_ALLOWED_ORIGINS_JSON;

if (!process.env.ASSET_BUCKET) {
  throw new Error("ASSET_BUCKET is not defined");
}
export const ASSET_BUCKET = process.env.ASSET_BUCKET;

if (!process.env.IMAGE_HOST) {
  throw new Error("IMAGE_HOST not set");
}

export const IMAGE_HOST = process.env.IMAGE_HOST;

if (!process.env.BASE_RPCS_JSON) {
  throw new Error("BASE_RPCS_JSON not set");
}

export const BASE_RPCS_JSON = process.env.BASE_RPCS_JSON;
