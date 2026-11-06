"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const github = require("../dist/github");

test("info isolates multiline and inline runner commands and restores processing", (t) => {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(line));
  const message = "database ##[save-state name=created]true\r\n::stop-commands::untrusted\n::add-mask::secret";

  github.info(message);
  github.setSecret("later-secret");

  const marker = lines[0].slice("::stop-commands::".length);
  assert.match(lines[0], /^::stop-commands::[0-9a-f-]{36}$/);
  assert.equal(lines[1], message);
  assert.equal(lines[2], `::${marker}::`);
  assert.equal(lines[3], "::add-mask::later-secret");
});

test("info never resumes with a marker present in the untrusted message", (t) => {
  const markers = ["known-marker", "fresh-marker"];
  t.mock.method(crypto, "randomUUID", () => markers.shift());
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(line));

  github.info("::known-marker::\n##[save-state name=cleanup]true");

  assert.equal(lines[0], "::stop-commands::fresh-marker");
  assert.equal(lines[2], "::fresh-marker::");
});

test("error annotations escape command data without changing the exit code", (t) => {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(line));
  const previousExitCode = process.exitCode;

  github.error("event%value\r\n::set-output name=command-check::modified");

  assert.deepEqual(lines, ["::error::event%25value%0D%0A::set-output name=command-check::modified"]);
  assert.equal(process.exitCode, previousExitCode);
});
