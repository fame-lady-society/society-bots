import { describe, expect, it, jest } from "@jest/globals";
import type { SQSEvent } from "aws-lambda";
import { processDeferredEvent } from "./deferred-processing.ts";

function record(messageId: string, payload: object): SQSEvent["Records"][number] {
  return {
      messageId,
      receiptHandle: "receipt",
      body: JSON.stringify({ Message: JSON.stringify(payload) }),
      attributes: { ApproximateReceiveCount: "1", SentTimestamp: "0", SenderId: "sender", ApproximateFirstReceiveTimestamp: "0" },
      messageAttributes: {},
      md5OfBody: "hash",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:000000000000:queue",
      awsRegion: "us-east-1",
  };
}

function event(...records: SQSEvent["Records"]): SQSEvent {
  return { Records: records };
}

function channelMessage(messageId: string) {
  return record(messageId, { type: "discord:channelMessage", channelId: "channel", message: { content: "hello" } });
}

describe("deferred Discord delivery", () => {
  it("returns a partial-batch failure so Discord errors are retried", async () => {
    const messageHandler = jest.fn<(channelId: string, message: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Discord unavailable"))
      .mockResolvedValueOnce(undefined);
    const dependencies = {
      parseMessage: (message: string) => JSON.parse(message),
      commandHandler: jest.fn(),
      messageHandler,
      sendInteraction: jest.fn(),
      onError: jest.fn(),
    };

    await expect(processDeferredEvent(event(channelMessage("message-1")), dependencies as never)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "message-1" }],
    });
    await expect(processDeferredEvent(event(channelMessage("message-1")), dependencies as never)).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(messageHandler).toHaveBeenCalledTimes(2);
  });

  it("processes deferred interactions and reports only the failed record in a mixed batch", async () => {
    const response = { content: "done" };
    const commandHandler = jest.fn(async () => response);
    const sendInteraction = jest.fn(async () => undefined);
    const messageHandler = jest.fn(async () => { throw new Error("Discord unavailable"); });
    const interaction = { type: 2, token: "interaction-token", data: { name: "ping", type: 1 } };
    const dependencies = {
      parseMessage: (message: string) => JSON.parse(message),
      commandHandler,
      messageHandler,
      sendInteraction,
      onError: jest.fn(),
    };

    await expect(processDeferredEvent(event(
      record("interaction-1", { type: "defer", interaction }),
      channelMessage("message-2"),
    ), dependencies as never)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "message-2" }],
    });
    expect(commandHandler).toHaveBeenCalledWith(interaction);
    expect(sendInteraction).toHaveBeenCalledWith("interaction-token", response);
    expect(messageHandler).toHaveBeenCalledTimes(1);
  });
});
