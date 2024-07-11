import { createLogger } from "@0xflick/backend";
export const logger = createLogger({
  name: "discord/commands/ping/common",
}).child({
  command: "ping",
});
