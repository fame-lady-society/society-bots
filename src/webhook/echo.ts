import { createServer } from "http";

const server = createServer((req, res) => {
  // echo the request body to console, adding a newline at the end
  req.pipe(process.stdout);
  req.on("end", () => console.log());

  res.write("OK");
  res.end();
});

server.listen(8081);
