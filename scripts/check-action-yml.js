"use strict";

const fs = require("fs");

const text = fs.readFileSync("action.yml", "utf8");
const required = [
  "name: DB9 Action",
  "description: Create temporary DB9 databases for GitHub Actions.",
  "runs:",
  'using: "node24"',
  'main: "dist/index.js"',
  'post: "dist/cleanup.js"',
  "database-url:",
  "expires-at:",
];

const missing = required.filter((needle) => !text.includes(needle));
if (missing.length > 0) {
  console.error(`action.yml is missing expected content:\n${missing.join("\n")}`);
  process.exit(1);
}
