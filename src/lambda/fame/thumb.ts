import { S3 } from "@aws-sdk/client-s3";
import {
  type APIGatewayProxyEvent,
  type APIGatewayProxyResult,
} from "aws-lambda";
import { baseClient } from "@/viem.ts";
import { resizeImage } from "@/canvas/fls.ts";
import {
  ASSET_BUCKET,
  IMAGE_HOST,
  CORS_ALLOWED_ORIGINS_JSON,
} from "./config.ts";
import { fetchFameSocietyRevealerIndex, fetchTokenImage } from "./utils.ts";

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
  console.log("Received image request");
  try {
    if (["GET", "OPTIONS", "HEAD"].includes(event.httpMethod)) {
      return {
        statusCode: 405,
        body: "Method Not Allowed",
      };
    }
    const { pathParameters } = event;

    const tokenIdStr = pathParameters!.tokenId!;
    console.log(`tokenID: ${tokenIdStr}`);
    const index = await fetchFameSocietyRevealerIndex({ client: baseClient });
    const s3Key = `assets/thumb/reveal-${index.toString()}/${tokenIdStr}.png`;
    const exists = await s3Exists({ key: s3Key, bucket: assetBucket });

    if (!exists) {
      console.log(`image not found in S3: ${s3Key}`);
      const imageArrayBuffer = await fetchTokenImage(tokenIdStr);
      const imageBuffer = Buffer.from(imageArrayBuffer);
      const imageData = await resizeImage({
        imageBuffer,
        width: 400,
        height: 400,
      });

      console.log("Saving canvas to S3");
      await s3WriteObject(s3Key, imageData);
      console.log("Done");
      return {
        statusCode: 302,
        headers: {
          Location: `https://${imageHost}/${s3Key}`,
        },
        body: "",
      };
    }
    console.log(`image found in S3: ${s3Key}`);
    console.log("Returning image");
    return {
      statusCode: 302,
      headers: {
        Location: `https://${imageHost}/${s3Key}`,
      },
      body: "",
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: "Oops, something went wrong",
    };
  }
};

process.on("uncaughtException", (err, origin) => {
  console.error(err, origin);
});
