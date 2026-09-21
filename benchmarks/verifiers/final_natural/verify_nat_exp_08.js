
const http = require("http");
const express = require("./");
const app = express();
app.use((req, res) => {
  const encodedHey = new TextEncoder().encode("hey");
  res.set("Content-Type", "text/plain").send(encodedHey);
});
const server = app.listen(0, () => {
  const port = server.address().port;
  http.get("http://127.0.0.1:" + port, (res) => {
    let data = "";
    res.on("data", c => { data += c; });
    res.on("end", () => {
      server.close();
      if (data !== "hey") process.exit(1);
      process.exit(0);
    });
  }).on("error", () => {
    server.close();
    process.exit(1);
  });
});
