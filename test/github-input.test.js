"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const github = require("../dist/github");

test("inputs ignore underscore aliases for hyphenated names", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });

  for (const name of ["db9-api-url", "source-database-id", "database-name-prefix", "export-env"]) {
    delete process.env[`INPUT_${name.toUpperCase()}`];
    process.env[`INPUT_${name.replace(/-/g, "_").toUpperCase()}`] = "injected";
    assert.equal(github.getInput(name), "");
  }
  assert.equal(github.getBooleanInput("export-env", true), true);
});

test("canonical inputs retain their normal handling", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });

  process.env["INPUT_DB9-API-URL"] = " https://custom.example.test ";
  process.env.INPUT_DB9_API_URL = "https://unrelated.example.test";
  assert.equal(github.getInput("db9-api-url"), "https://custom.example.test");
  assert.equal(github.getInput("db9-api-url", { trimWhitespace: false }), " https://custom.example.test ");

  process.env.INPUT_WAIT = "false";
  assert.equal(github.getBooleanInput("wait", true), false);

  process.env["INPUT_DB9-API-URL"] = "";
  assert.throws(() => github.getInput("db9-api-url", { required: true }), /required/i);
});
