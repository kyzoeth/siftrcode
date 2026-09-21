
const express = require("./");
const app = express();
const res = Object.create(express.response);
res.headers = {};
res.set = function(field, val) { res.headers[field.toLowerCase()] = val; };
res.get = function(field) { return res.headers[field.toLowerCase()]; };

res.links({
  prev: ["http://example.com/1", "http://example.com/2"]
});

const link = res.get("link");
const target1 = "<http://example.com/1>; rel=" + String.fromCharCode(34) + "prev" + String.fromCharCode(34);
const target2 = "<http://example.com/2>; rel=" + String.fromCharCode(34) + "prev" + String.fromCharCode(34);
if (!link || !link.includes(target1) || !link.includes(target2)) {
  process.exit(1);
}
process.exit(0);
