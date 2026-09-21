
import { Help } from "./lib/help.js";
const h = new Help();
const width = h.displayWidth("\x1b[2Khello");
if (width !== 5) {
  process.exit(1);
}
process.exit(0);
