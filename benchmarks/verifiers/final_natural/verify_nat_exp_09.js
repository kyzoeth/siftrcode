
const express = require("./");
const req = Object.create(express.request);
Object.defineProperty(req, "socket", { value: { encrypted: true, remoteAddress: "127.0.0.1" }, configurable: true });
Object.defineProperty(req, "connection", { value: undefined, configurable: true });
req.app = express();
req.headers = {};
let proto;
try {
  proto = req.protocol;
} catch (e) {
  process.exit(1);
}
if (proto !== "https") process.exit(1);
process.exit(0);
