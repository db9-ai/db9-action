"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const github = require("../dist/github");

function parseFileCommands(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const entries = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    const separator = line.indexOf("=");
    const heredoc = line.indexOf("<<");
    if (heredoc >= 0 && (separator < 0 || heredoc < separator)) {
      const name = line.slice(0, heredoc);
      const delimiter = line.slice(heredoc + 2);
      const value = [];
      while (++i < lines.length && lines[i] !== delimiter) {
        value.push(lines[i]);
      }
      assert.ok(i < lines.length, `Missing delimiter for ${name}`);
      entries[name] = value.join("\n");
    } else {
      assert.ok(separator > 0, `Invalid command: ${line}`);
      entries[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return entries;
}

test("multiline output, environment, and state values cannot add file commands", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "db9-file-command-"));
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.env.GITHUB_OUTPUT = path.join(directory, "output");
  process.env.GITHUB_ENV = path.join(directory, "env");
  process.env.GITHUB_STATE = path.join(directory, "state");

  const value = "original\napi-url=https://attacker.example\nNODE_OPTIONS=--require /tmp/injected.js";
  github.setOutput("database-url", value);
  github.exportVariable("DATABASE_URL", value);
  github.saveState("access-token", value);

  assert.deepEqual(parseFileCommands(process.env.GITHUB_OUTPUT), { "database-url": value });
  assert.deepEqual(parseFileCommands(process.env.GITHUB_ENV), { DATABASE_URL: value });
  assert.deepEqual(parseFileCommands(process.env.GITHUB_STATE), { "access-token": value });
});

test("paths containing newlines cannot add multiple PATH entries", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "db9-path-command-"));
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.env.GITHUB_PATH = path.join(directory, "path");
  const initialPath = process.env.PATH;

  assert.throws(() => github.addPath("/safe\n/attacker"), /newline/i);
  assert.equal(process.env.PATH, initialPath);
  assert.equal(fs.existsSync(process.env.GITHUB_PATH), false);
});
