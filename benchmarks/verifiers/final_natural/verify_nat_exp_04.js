
const express = require("./");
const app = express();
const res = Object.create(express.response);
res.app = app;
res.req = { headers: {} };
res.headers = {};
let count = 0;
res.set = function(field, val) {
  if (typeof field === "string" && field.toLowerCase() === "content-type") count++;
  res.headers[field.toLowerCase()] = val;
};
res.get = function(field) { return res.headers[field.toLowerCase()]; };
res.end = function() {};
res.send("hello");
if (count !== 1) process.exit(1);
process.exit(0);
