import { S3 } from "@aws-sdk/client-s3";
import { generateMosaic } from "@0xflick/assets/src/canvas/fls";
import type { Readable } from "stream";
import { APIGatewayProxyHandler } from "aws-lambda";
import { Image, loadImage } from "canvas";

const s3 = new S3({
  region: "us-east-1",
});

if (!process.env.ASSET_BUCKET) {
  throw new Error("ASSET_BUCKET not set");
}
if (!process.env.IMAGE_HOST) {
  throw new Error("IMAGE_HOST not set");
}
const assetBucket = process.env.ASSET_BUCKET;
const imageHost = process.env.IMAGE_HOST;

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

async function getImageFromS3(key: string): Promise<Buffer> {
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

/**
 *
 * @param key {string}
 * @param imageData {Buffer}
 * @returns {Promise<void>}
 */
async function s3WriteObject(key: string, imageData: Buffer): Promise<void> {
  console.log(`Writing to s3://${assetBucket}/${key}`);
  const params = {
    Bucket: assetBucket,
    Key: key,
    Body: imageData,
    ACL: "public-read",
    ContentDisposition: "inline",
    ContentType: "image/png",
  };
  await s3.putObject(params);
}

// Handler
export const handler: APIGatewayProxyHandler = async (event) => {
  console.log("Received image request");
  try {
    if (event.httpMethod !== "GET") {
      return {
        statusCode: 405,
        body: "Method Not Allowed",
      };
    }
    const { pathParameters } = event;

    const tokenIdsStr = pathParameters.tokenIds;
    console.log(`tokenIDS: ${tokenIdsStr}`);
    // tokenIdsStr is a comma separated list of tokenIds, for each tokenID, fetch the image from S3
    const tokenIds = tokenIdsStr
      .split(",")
      .map((id) => parseInt(id, 10))
      .sort((a, b) => a - b);

    const outputKey = `mosaic/${tokenIds.join("-")}.png`;
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
          const key = `thumb/${id}.png`;
          const buffer = await getImageFromS3(key);
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
