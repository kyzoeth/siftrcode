
const http = require("http");
const express = require("./");
const app = express();
app.use((req, res) => {
  res.redirect(302, "http://example.com");
});
const server = app.listen(0, () => {
  const port = server.address().port;
  const req = http.request({
    hostname: "127.0.0.1",
    port: port,
    path: "/",
    headers: { "Accept": "text/html" }
  }, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      server.close();
      if (!data.includes("<!DOCTYPE html>")) process.exit(1);
      process.exit(0);
    });
  });
  req.on("error", () => {
    server.close();
    process.exit(1);
  });
  req.end();
});
