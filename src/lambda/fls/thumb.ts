import { S3 } from "@aws-sdk/client-s3";
import { resizeImage } from "@0xflick/assets/src/canvas/fls";
import { create as createIpfsHttpClient } from "ipfs-http-client";
import { APIGatewayProxyHandler } from "aws-lambda";

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
const ipfsApiAuth = process.env.IPFS_API_AUTH;
const ipfsApiUrl = process.env.IPFS_API_URL;
const baseCid = process.env.BASE_CID;

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

    const tokenIdStr = pathParameters.tokenId;
    console.log(`tokenID: ${tokenIdStr}`);

    const s3Key = `thumb/${tokenIdStr}.png`;
    const exists = await s3Exists({ key: s3Key, bucket: assetBucket });

    if (!exists) {
      console.log(`image not found in S3: ${s3Key}`);
      const ipfsHttpClient = createIpfsHttpClient({
        host: ipfsApiUrl,
        protocol: "https",
        headers: {
          Authorization: ipfsApiAuth,
        },
      });
      const imageData = await resizeImage({
        ipfsHttpClient,
        ipfsCid: `${baseCid}/${tokenIdStr}`,
        width: 400,
        height: 400,
      });

      console.log("Saving canvas to S3");
      await s3WriteObject(s3Key, imageData);
      console.log("Done");
      return {
        statusCode: 302,
        headers: {
          ["Location"]: `https://${imageHost}/${s3Key}`,
        },
        body: "",
      };
    }
    console.log(`image found in S3: ${s3Key}`);
    console.log("Returning image");
    return {
      statusCode: 302,
      headers: {
        ["Location"]: `https://${imageHost}/${s3Key}`,
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
