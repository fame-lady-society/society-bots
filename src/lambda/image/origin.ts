import axios from "axios";
import { cidPath as isCidPath, cid as isCid } from "is-ipfs";
import type {
  CloudFrontResponseCallback,
  CloudFrontResponseEvent,
} from "aws-lambda";
import AWS from "aws-sdk";
import { UrlShortenerDAO, fetchTableNames, createDb } from "@0xflick/backend";
import Sharp, { AvailableFormatInfo, FormatEnum } from "sharp";

import {
  create as createIpfsHttpClient,
  IPFSHTTPClient,
} from "ipfs-http-client";

const S3 = new AWS.S3({
  signatureVersion: "v4",
});

const ssm = new AWS.SSM({
  region: "us-east-1",
});

const [bucketResult, ipfsApiAuth, corsAllowedHost] = await Promise.all([
  ssm.getParameter({ Name: "/edge/ImageOriginBucket" }).promise(),
  ssm.getParameter({ Name: "/edge/ImageOriginIPFSApiAuth" }).promise(),
  ssm.getParameter({ Name: "/edge/ImageCorsAllowedOrigins" }).promise(),
]);

const BUCKET = bucketResult.Parameter?.Value;
const IPFS_AUTH = ipfsApiAuth.Parameter?.Value;
const CORS_ALLOWED_ORIGINS = corsAllowedHost.Parameter?.Value;

const cors = {
  allow: JSON.parse(CORS_ALLOWED_ORIGINS),
  allowCredentials: true,
};

if (!BUCKET) {
  throw new Error("BUCKET is not set");
}
if (!IPFS_AUTH) {
  throw new Error("IPFS_AUTH is not set");
}

const IPFS_API = "ipfs.infura.io:5001";

const ipfsClient = createIpfsHttpClient({
  host: IPFS_API,
  protocol: "https",
  headers: {
    Authorization: IPFS_AUTH,
  },
});

const s3Exists = async (key: string) => {
  try {
    await S3.headObject({
      Bucket: BUCKET,
      Key: key,
    }).promise();
    return true;
  } catch (err) {
    return false;
  }
};

export async function loadIpfsContent(
  ipfsClient: IPFSHTTPClient,
  ipfsCid: string
) {
  const contents: Uint8Array[] = [];
  for await (const metadataBuf of ipfsClient.cat(ipfsCid)) {
    contents.push(metadataBuf);
  }
  return Buffer.concat(contents);
}

const getUrlShortenerDao = (() => {
  let instance: UrlShortenerDAO;
  return async () => {
    if (!instance) {
      const region = await fetchTableNames({
        paramName: "Image_DynamoDB_TableNames",
        region: "us-east-1",
      });
      instance = new UrlShortenerDAO(
        createDb({
          region,
        })
      );
    }
    return instance;
  };
})();

export const handler = async (
  event: CloudFrontResponseEvent,
  _: void,
  callback: CloudFrontResponseCallback
): Promise<void> => {
  const response = event.Records[0].cf.response;
  const request = event.Records[0].cf.request;

  console.log("Response status code :%s", response.status);
  console.log("Request headers", JSON.stringify(request.headers));
  try {
    if ("origin" in request.headers && isAllowed(request.headers.origin)) {
      console.log("Allowed origin:", request.headers.origin[0].value);
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
      console.log("Image not found");
      const request = event.Records[0].cf.request;

      // read the required path. Ex: uri /images/100x100/webp/image.jpg
      const path = request.uri;

      // read the S3 key from the path variable.
      // Ex: path variable /images/100x100/webp/image.jpg
      const key = path.substring(1);

      // parse the prefix, width, height and image name
      // Ex: key=images/200x200/webp/image.jpg
      let match = key.match(
        /(ipfs|web)\/(.*)\/(\d+|auto)x(\d+|auto)\/(.*)\/(.*)/
      );
      let type: string,
        prefix: string | undefined,
        width: string,
        height: string,
        imageName: string | undefined,
        originalKey: string,
        pathKey: string,
        requiredFormat: string;
      if (!match) {
        console.log(`Let's try again: ${key}`);
        match = key.match(/(ipfs|web)\/(.*)\/(\d+|auto)x(\d+|auto)\/(.*)/);
        if (!match) {
          console.log("nope");
          return callback(null, response);
        }
        type = match[1];
        pathKey = match[2];
        width = match[3];
        height = match[4];
        requiredFormat = match[5] == "jpg" ? "jpeg" : match[5];
        originalKey = `${type}/${pathKey}`;
        prefix = undefined;
        imageName = undefined;
      } else {
        type = match[1];
        prefix = match[2];
        width = match[3];
        height = match[4];

        // correction for jpg required for 'Sharp'
        requiredFormat = match[5] == "jpg" ? "jpeg" : match[5];
        imageName = match[6];
        originalKey = `${type}/${prefix}${imageName ? `/${imageName}` : ""}`;
        pathKey = `${prefix}${imageName ? `/${imageName}` : ""}`;
      }
      console.log(
        `type: ${type} prefix: ${prefix} width: ${width} height: ${height} pathKey: ${pathKey} imageName: ${imageName} originalKey: ${originalKey} requiredFormat ${requiredFormat}`
      );

      // Check if the image does not exist in S3
      let buffer: Buffer;
      if (!(await s3Exists(originalKey))) {
        // Check if the key is a CID
        if (type === "web" && prefix && imageName) {
          const urlShortenerDao = await getUrlShortenerDao();
          const model = await urlShortenerDao.get(prefix);
          if (!model) {
            console.log(`Key ${prefix} not found`);
            return callback(null, response);
          }
          const { url } = model;
          const imageResponse = await axios.get(`${url}/${imageName}`, {
            responseType: "arraybuffer",
          });
          buffer = Buffer.from(imageResponse.data, "binary");
        } else if (type === "ipfs") {
          if (!isCidPath(pathKey) && !isCid(pathKey)) {
            console.log(`Invalid key: ${pathKey}`);
            response.status = "404";
            return callback(null, response);
          }

          console.log("IPFS request: ", pathKey);
          buffer = await loadIpfsContent(ipfsClient, pathKey);
        } else {
          console.log(`Invalid type: ${type}`);
          response.status = "404";
          return callback(null, response);
        }

        // Cache the image in S3
        await S3.putObject({
          Body: buffer,
          Bucket: BUCKET,
          ContentType: "image/" + requiredFormat,
          CacheControl: "max-age=31536000",
          Key: originalKey,
          StorageClass: "STANDARD",
        }).promise();
      } else {
        // Fetch from S3
        console.log("Fetching from S3");
        const response = await S3.getObject({
          Bucket: BUCKET,
          Key: originalKey,
        }).promise();
        buffer = response.Body as Buffer;
      }
      buffer = await Sharp(buffer)
        .resize(
          width === "auto" ? null : Number(width),
          height === "auto" ? null : Number(height)
        )
        .toFormat(requiredFormat as keyof FormatEnum | AvailableFormatInfo)
        .toBuffer();
      // save the resized object to S3 bucket with appropriate object key.
      await S3.putObject({
        Body: buffer,
        Bucket: BUCKET,
        ContentType: "image/" + requiredFormat,
        CacheControl: "max-age=31536000",
        Key: key,
        StorageClass: "STANDARD",
      })
        .promise()
        // even if there is exception in saving the object we send back the generated
        // image back to viewer below
        .catch(() => {
          console.error("Exception while writing resized image to bucket");
        });

      // generate a binary response with resized image
      return callback(null, {
        status: "200",
        body: buffer.toString("base64"),
        bodyEncoding: "base64",
        headers: {
          ...response.headers,
          "content-type": [
            { key: "Content-Type", value: "image/" + requiredFormat },
          ],
        },
      });
    } // end of if block checking response statusCode
    else {
      // allow the response to pass through
      return callback(null, response);
    }
  } catch (err: any) {
    console.error(err);
    return callback(null, {
      status: "500",
      headers: {
        ...response.headers,
      },
      statusDescription: "Internal Server Error",
      body: JSON.stringify({
        error: err.message,
      }),
    });
  }
};

const isAllowed = (
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
