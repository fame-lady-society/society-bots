import type {
  CloudFrontResponseCallback,
  CloudFrontResponseEvent,
} from "aws-lambda";
import type { Readable } from "stream";
import { cidPath as isCidPath, cid as isCid } from "is-ipfs";
import { S3 } from "@aws-sdk/client-s3";
import { SSM } from "@aws-sdk/client-ssm";
import { fetchBuffer } from "../../ipfs/client";

const s3 = new S3({
  region: "us-east-1",
});

const ssm = new SSM({
  region: "us-east-1",
});

const params = Promise.all([
  ssm.getParameter({ Name: "/edge/fls/IpfsOriginBucket" }),
  ssm.getParameter({ Name: "/edge/fls/IpfsOriginIPFSApiAuth" }),
  ssm.getParameter({ Name: "/edge/fls/IpfsCorsAllowedOrigins" }),
]);

export async function loadIpfsContent(ipfsCid: string, key: string) {
  return await fetchBuffer({ cid: ipfsCid, key });
}

export const handler = async (
  event: CloudFrontResponseEvent,
  _: void,
  callback: CloudFrontResponseCallback
): Promise<void> => {
  const [bucketResult, ipfsApiAuth, corsAllowedHosts] = await params;

  const BUCKET = bucketResult.Parameter?.Value;
  const IPFS_AUTH = ipfsApiAuth.Parameter?.Value;
  const CORS_ALLOWED_ORIGINS = JSON.parse(corsAllowedHosts.Parameter?.Value);

  if (!BUCKET) {
    throw new Error("BUCKET is not set");
  }
  if (!IPFS_AUTH) {
    throw new Error("IPFS_AUTH is not set");
  }

  const cors = {
    allow: CORS_ALLOWED_ORIGINS,
    allowCredentials: true,
  };

  const s3Exists = async (key: string) => {
    try {
      await s3.headObject({
        Bucket: BUCKET,
        Key: key,
      });
      return true;
    } catch (err) {
      return false;
    }
  };
  const response = event.Records[0].cf.response;
  const request = event.Records[0].cf.request;

  console.log("Response status code :%s", response.status);
  try {
    if (
      "origin" in request.headers &&
      isAllowed(cors, request.headers.origin)
    ) {
      response.headers["access-control-allow-origin"] = [
        {
          key: "Access-Control-Allow-Origin",
          value: request.headers.origin[0].value,
        },
      ];
      response.headers["access-control-allow-methods"] = [
        { key: "Access-Control-Allow-Methods", value: "GET, HEAD" },
      ];
      response.headers["access-control-max-age"] = [
        { key: "Access-Control-Max-Age", value: "86400" },
      ];
    }
    //check if image is not present
    if (Number(response.status) === 404 || Number(response.status) === 403) {
      const request = event.Records[0].cf.request;

      // read the required path. Ex: uri /QM234234234/image.png
      const path = request.uri;

      // read the S3 key from the path variable.
      // Ex: path variable QM234234234/image.png
      const key = path.substring(1);
      console.log(`key: ${key}`);

      // Check if the image does not exist in S3
      let buffer: Buffer;
      if (!isCidPath(key) && !isCid(key)) {
        console.log("Not a CID");
        return callback(null, {
          status: "404",
          body: "Not Found",
          headers: {
            ...response.headers,
          },
        });
      }
      let isJson = false;
      if (!(await s3Exists(key))) {
        console.log("Not in S3");
        buffer = await loadIpfsContent(key, IPFS_AUTH);

        try {
          JSON.parse(buffer.toString());
          console.log("JSON");
          isJson = true;
        } catch (_) {
          console.log("Not JSON");
          // nothing
        }
        // Cache the image in S3
        await s3.putObject({
          Body: buffer,
          Bucket: BUCKET,
          ContentType: isJson ? "application/json" : "application/octet-stream",
          CacheControl: "max-age=31536000",
          Key: key,
          StorageClass: "STANDARD",
        });
        console.log("Cached in S3");
      } else {
        // Fetch from S3
        console.log("Fetching from S3");
        const response = await s3.getObject({
          Bucket: BUCKET,
          Key: key,
        });
        const stream = response.Body as Readable;
        buffer = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.once("end", () => resolve(Buffer.concat(chunks)));
          stream.once("error", reject);
        });
        isJson = response.ContentType === "application/json";
      }

      // generate a binary response
      return callback(null, {
        status: "200",
        body: buffer.toString("base64"),
        bodyEncoding: "base64",
        headers: {
          ...response.headers,
          ...(isJson
            ? {
                "content-type": [
                  { key: "Content-Type", value: "application/json" },
                ],
              }
            : {}),
        },
      });
    } // end of if block checking response statusCode
    else {
      console.log("Not a 404 or 403");
      // allow the response to pass through
      return callback(null, response);
    }
  } catch (err: unknown) {
    console.error(err);
    return callback(null, {
      status: "500",
      headers: {
        ...response.headers,
      },
      statusDescription: "Internal Server Error",
      body: "Internal Server Error",
    });
  }
};

const isAllowed = (
  cors: {
    allow: string[];
    allowCredentials: boolean;
  },
  origin: {
    key?: string | undefined;
    value: string;
  }[]
) => {
  const o = origin[0].value;
  return (
    o == undefined ||
    cors.allow
      .map((ao) => ao == "*" || ao.indexOf(o) !== -1)
      .reduce((prev, current) => prev || current)
  );
};

process.on("uncaughtException", (err, origin) => {
  console.error(err, origin);
});
