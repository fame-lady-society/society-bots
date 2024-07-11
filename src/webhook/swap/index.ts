import { APIGatewayProxyHandler } from "aws-lambda";
import crypto from "node:crypto";
import handleSwapEvent from "./handler.js";

const WEBHOOK_TOKEN = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY!;

function isValidSignature(body: string, signature: string) {
  const hmac = crypto.createHmac("sha256", WEBHOOK_TOKEN); // Create a HMAC SHA256 hash using the auth token
  hmac.update(body, "utf8"); // Update the token hash with the request body using utf8
  const digest = hmac.digest("hex");
  return signature === digest; // If signature equals your computed hash, return true
}

export const handler: APIGatewayProxyHandler = async (event) => {
  console.log(event.body);
  if (event.body === null) {
    return {
      statusCode: 400,
      body: "Bad Request",
    };
  }

  const headers = event.headers;
  const signature = headers["x-alchemy-signature"];
  if (!signature) {
    console.warn("No signature present", headers);
    // return {
    //   statusCode: 401,
    //   body: "Unauthorized",
    // };
  } else if (!isValidSignature(event.body, signature)) {
    console.warn("unable to verify signature", headers);
    // return {
    //   statusCode: 403,
    //   body: "Not Authorized",
    // };
  }
  try {
    const json = JSON.parse(event.body);
    await handleSwapEvent({
      event: json.event,
      destination: Number(process.env.TELEGRAM_CHAT_ID!),
    });
  } catch (e) {
    console.error(e);
  }
  return {
    statusCode: 200,
    body: "OK",
  };
};
