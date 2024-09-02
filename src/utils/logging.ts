import {
  createLogger as bunyanCreateLogger,
  type LogLevel,
  type LoggerOptions,
} from "bunyan";

function toLogLevel(level: string): LogLevel {
  switch (level) {
    case "trace":
      return "trace";
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "fatal":
      return "fatal";
    default:
      return "info";
  }
}

export const logger = bunyanCreateLogger({
  name: "society-bot",
  level: toLogLevel(process.env.LOG_LEVEL || "info"),
});

export function createLogger(options: LoggerOptions) {
  return logger.child(options);
}
