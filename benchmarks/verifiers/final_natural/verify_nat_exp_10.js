
const path = require("path");
const http = require("http");
const express = require("./");
const app = express();
app.disable("etag");
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "package.json"));
});
const server = app.listen(0, () => {
  const port = server.address().port;
  http.get("http://127.0.0.1:" + port, (res) => {
    server.close();
    if (res.headers["etag"]) process.exit(1);
    process.exit(0);
  }).on("error", () => {
    server.close();
    process.exit(1);
  });
});
