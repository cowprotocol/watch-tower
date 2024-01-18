const { compileFromFile } = require("json-schema-to-typescript");
const fs = require("fs");
const path = require("path");

// path to your JSON schema
const schemaPath = path.join(__dirname, "config.schema.json");

compileFromFile(schemaPath)
  .then((ts) => fs.writeFileSync(path.join(__dirname, "./types.d.ts"), ts))
  .catch((error) => console.error(error));
