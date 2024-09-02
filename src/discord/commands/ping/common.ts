import { createLogger } from "@/utils/logging.js";
export const logger = createLogger({
  name: "discord/commands/ping/common",
}).child({
  command: "ping",
});
