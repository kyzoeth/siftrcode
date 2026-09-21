
const { Option } = require("./");
let opt;
try {
  opt = new Option("--ws, --workspace");
} catch (e) {
  process.exit(1);
}
if (!opt || opt.long !== "--workspace") {
  process.exit(1);
}
process.exit(0);
