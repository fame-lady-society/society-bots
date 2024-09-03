export function lazy<R>(getter: () => R) {
  return {
    get() {
      return getter();
    },
  };
}

export function lazySingleton<R>(getter: () => R) {
  let value: R;
  return lazy<R>(() => {
    if (!value) {
      value = getter();
    }
    return value;
  });
}

export const discordBotToken = lazy(() => {
  if (!process.env.DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN is not set");
  }
  return process.env.DISCORD_BOT_TOKEN;
});

export const deferredMessageTopicArn = lazy(function getTopicArn() {
  if (!process.env.DISCORD_MESSAGE_TOPIC_ARN) {
    throw new Error("DISCORD_MESSAGE_TOPIC_ARN not set");
  }
  return process.env.DISCORD_MESSAGE_TOPIC_ARN;
});

export const publicKey = lazy(() => {
  if (!process.env.DISCORD_PUBLIC_KEY) {
    throw new Error("DISCORD_PUBLIC_KEY not set");
  }
  return process.env.DISCORD_PUBLIC_KEY;
});

export const imageHost = lazy(() => {
  if (!process.env.IMAGE_HOST) {
    throw new Error("IMAGE_HOST not set");
  }
  return process.env.IMAGE_HOST;
});
