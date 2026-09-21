
const express = require("./");
const req = Object.create(express.request);
const res = Object.create(express.response);
req.method = "QUERY";
req.headers = { "if-none-match": String.fromCharCode(34) + "12345" + String.fromCharCode(34) };
req.res = res;
res.statusCode = 200;
res.get = (h) => (h.toLowerCase() === "etag" ? String.fromCharCode(34) + "12345" + String.fromCharCode(34) : undefined);
if (req.fresh !== true) process.exit(1);
process.exit(0);
