
const path = require("path");
const express = require("./");
const app = express();
app.set("views", path.join(__dirname, "test/fixtures"));
app.engine("tmpl", (path, options, fn) => fn(null, "rendered"));
let threw = false;
try {
  app.render("user.tmpl", null, (err, str) => {
    if (err) threw = true;
  });
} catch (e) {
  threw = true;
}
if (threw) process.exit(1);
process.exit(0);
