const fs = require("fs");
const path = require("path");
const { version, name, description } = require("../../../package.json");

fs.writeFileSync(
  path.join(__dirname, "../src/version.json"),
  JSON.stringify(
    {
      version,
      name,
      description,
    },
    null,
    2
  )
);
