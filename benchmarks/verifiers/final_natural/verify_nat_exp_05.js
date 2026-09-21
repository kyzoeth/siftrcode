
const http = require("http");
const express = require("./");
const app = express();
app.use((req, res) => {
  res.set("Transfer-Encoding", "chunked");
  res.send("hello");
});
const server = app.listen(0, () => {
  const port = server.address().port;
  http.get("http://127.0.0.1:" + port, (res) => {
    server.close();
    if (!res.headers["etag"]) process.exit(1);
    process.exit(0);
  }).on("error", () => {
    server.close();
    process.exit(1);
  });
});
