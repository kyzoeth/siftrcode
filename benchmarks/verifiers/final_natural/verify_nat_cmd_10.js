
const { Option } = require("./");
let threw = false;
try {
  new Option("-ws");
} catch (err) {
  threw = true;
}
if (!threw) {
  process.exit(1);
}
process.exit(0);
