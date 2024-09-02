import { S3 } from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import {
  type APIGatewayProxyEvent,
  type APIGatewayProxyResult,
} from "aws-lambda";
import { Image, loadImage } from "canvas";
import { generateMosaic, resizeImage } from "@/canvas/fls.ts";
import { baseClient } from "@/viem.ts";
import { fetchFameSocietyRevealerIndex, fetchTokenImage } from "./utils.ts";
import {
  ASSET_BUCKET,
  CORS_ALLOWED_ORIGINS_JSON,
  IMAGE_HOST,
} from "./config.ts";

const s3 = new S3({});

const assetBucket = ASSET_BUCKET;
const imageHost = IMAGE_HOST;
const corsAllowedOrigins: string[] = JSON.parse(CORS_ALLOWED_ORIGINS_JSON);

async function s3Exists({
  key,
  bucket,
}: {
  key: string;
  bucket: string;
}): Promise<boolean> {
  const params = {
    Bucket: bucket,
    Key: key,
  };
  try {
    await s3.headObject(params);
    return true;
  } catch (err) {
    return false;
  }
}

async function s3GetObject(key: string): Promise<Buffer> {
  const params = {
    Bucket: assetBucket,
    Key: key,
  };
  const data = await s3.getObject(params);
  const stream = data.Body as Readable;
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
  return buffer;
}

async function fetchOrGenerateTokenImage(
  revealIndex: bigint,
  tokenId: string | number | bigint
): Promise<Buffer> {
  const key = `assets/thumb/reveal-${revealIndex}/${tokenId}.png`;
  if (await s3Exists({ key, bucket: assetBucket })) {
    return await s3GetObject(key);
  }
  const imageArrayBuffer = await fetchTokenImage(tokenId);
  const imageBuffer = Buffer.from(imageArrayBuffer);
  const imageData = await resizeImage({
    imageBuffer,
    width: 400,
    height: 400,
  });
  await s3WriteObject(key, imageData);
  return imageBuffer;
}

/**
 *
 * @param key {string}
 * @param imageData {Buffer}
 * @returns {Promise<void>}
 */
async function s3WriteObject(key: string, imageData: Buffer): Promise<void> {
  console.log(`Writing to s3://${assetBucket}/${key}`);
  await s3.putObject({
    Bucket: assetBucket,
    Key: key,
    Body: imageData,
    ContentDisposition: "inline",
    ContentType: "image/png",
  });
}

// Handler
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("Received image request");
  if (event.httpMethod === "OPTIONS") {
    if (!event.headers.origin) {
      console.log("No origin header");
      return {
        statusCode: 400,
        body: "Bad Request",
      };
    }
    if (!corsAllowedOrigins.includes(event.headers.origin)) {
      console.log(`Forbidden origin: ${event.headers.origin}`);
      return {
        statusCode: 403,
        body: "Forbidden",
      };
    }
    console.log("Received preflight request");
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": event.headers.origin,
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }
  try {
    if (["GET", "OPTIONS", "HEAD"].includes(event.httpMethod)) {
      return {
        statusCode: 405,
        body: "Method Not Allowed",
      };
    }
    const { pathParameters } = event;

    const tokenIdsStr = pathParameters!.tokenId!;
    console.log(`tokenIDS: ${tokenIdsStr}`);
    // tokenIdsStr is a comma separated list of tokenIds, for each tokenID, fetch the image from S3
    const tokenIds = tokenIdsStr
      .split(",")
      .map((id) => parseInt(id, 10))
      .sort((a, b) => a - b);
    const index = await fetchFameSocietyRevealerIndex({ client: baseClient });
    const outputKey = `assets/mosaic/reveal-${index.toString()}/${tokenIds.join(
      "-"
    )}.png`;
    const exists = await s3Exists({
      key: outputKey,
      bucket: assetBucket,
    });
    if (!exists) {
      console.log("Image not found in S3, fetching from S3");
      // Let's not goo too crazy. Let's just fetch 10 images at a time
      const images: Image[] = [];
      for (let i = 0; i < tokenIds.length; i += 10) {
        const ids = tokenIds.slice(i, i + 10);
        const promises = ids.map(async (id) => {
          const buffer = await fetchOrGenerateTokenImage(index, id);
          return await loadImage(buffer);
        });
        images.push(...(await Promise.all(promises)));
      }
      console.log(`Fetched ${images.length} images`);
      const canvas = await generateMosaic({ images });
      console.log("Generated mosaic");
      const buffer = canvas.toBuffer("image/png", { compressionLevel: 9 });
      await s3WriteObject(outputKey, buffer);
    }
    return {
      statusCode: 302,
      headers: {
        ["Location"]: `https://${imageHost}/${outputKey}`,
      },
      body: "",
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: "Internal Server Error",
    };
  }
};

process.on("uncaughtException", (err, origin) => {
  console.error(err, origin);
});
