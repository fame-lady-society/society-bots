import { createServer } from "http";
import handler from "./handler.js";

const server = createServer((req, res) => {
  // // echo the request body to console, adding a newline at the end
  // req.pipe(process.stdout);
  const chunks: Uint8Array[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    console.log(body);
    try {
      const json = JSON.parse(body);
      await handler(json.event);
    } catch (e) {
      console.error(e);
    }
  });

  res.write("OK");
  res.end();
});

server.listen(8081);
