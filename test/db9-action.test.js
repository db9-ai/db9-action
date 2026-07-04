"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildDb9Env,
  generateDatabaseName,
  runMain,
  parseDatabaseUrlFromEnv,
  parseJsonObject,
  sanitizeDatabaseName,
} = require("../dist/db9-action");

test("sanitizeDatabaseName keeps names DNS-like and bounded", () => {
  assert.equal(sanitizeDatabaseName("My Repo/Feature_DB!!"), "my-repo-feature-db");
  assert.equal(sanitizeDatabaseName("---"), "gha-db9");
  assert.equal(sanitizeDatabaseName("a".repeat(80)).length, 63);
});

test("generateDatabaseName uses GitHub run context", () => {
  const name = generateDatabaseName({
    GITHUB_REPOSITORY: "db9-ai/example-app",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
  });
  assert.equal(name, "gha-example-app-12345-2");
});

test("parseDatabaseUrlFromEnv reads DATABASE_URL output", () => {
  const url = "postgresql://user:token@pg.db9.ai:5433/postgres";
  assert.equal(parseDatabaseUrlFromEnv(`noise\nDATABASE_URL=${url}\n`), url);
});

test("parseDatabaseUrlFromEnv rejects missing output", () => {
  assert.throws(() => parseDatabaseUrlFromEnv("PG_URL=postgres://example"), /DATABASE_URL/);
});

test("parseJsonObject returns object JSON", () => {
  assert.deepEqual(parseJsonObject('{"id":"db_123","name":"ci"}', "create"), {
    id: "db_123",
    name: "ci",
  });
});

test("buildDb9Env injects DB9 settings without mutating process env", () => {
  const env = buildDb9Env(
    { apiKey: "key_123", apiUrl: "https://api.example.test" },
    { home: "/tmp/db9-home", installDir: "/tmp/db9-bin" },
  );
  assert.equal(env.DB9_API_KEY, "key_123");
  assert.equal(env.DB9_API_URL, "https://api.example.test");
  assert.equal(env.HOME, "/tmp/db9-home");
  assert.match(env.PATH, /^\/tmp\/db9-bin/);
});

test("runMain creates a database and writes GitHub outputs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "db9-action-test-"));
  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin);
  const db9 = path.join(bin, "db9");
  fs.writeFileSync(
    db9,
    `#!/bin/sh
set -eu
echo "$*" >> "${temp}/calls.log"
if [ "$1" = "--json" ] && [ "$2" = "create" ]; then
  printf '{"id":"db_123","name":"ci-db"}\\n'
  exit 0
fi
if [ "$1" = "db" ] && [ "$2" = "connect" ]; then
  printf 'DATABASE_URL=postgresql://user:secret@pg.db9.ai:5433/postgres\\n'
  exit 0
fi
echo "unexpected args: $*" >&2
exit 2
`,
    { mode: 0o755 },
  );

  const previous = { ...process.env };
  try {
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ""}`;
    process.env.GITHUB_REPOSITORY = "db9-ai/example";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_RUN_ATTEMPT = "1";
    process.env.RUNNER_TEMP = temp;
    process.env.GITHUB_OUTPUT = path.join(temp, "output");
    process.env.GITHUB_ENV = path.join(temp, "env");
    process.env.GITHUB_STATE = path.join(temp, "state");
    process.env["INPUT_INSTALL-CLI"] = "false";
    process.env["INPUT_DATABASE-NAME"] = "ci-db";
    process.env["INPUT_CLEANUP"] = "true";

    runMain();

    assert.match(fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8"), /database-url=postgresql:\/\/user:secret@pg\.db9\.ai:5433\/postgres/);
    assert.match(fs.readFileSync(process.env.GITHUB_ENV, "utf8"), /DATABASE_URL=postgresql:\/\/user:secret@pg\.db9\.ai:5433\/postgres/);
    assert.match(fs.readFileSync(process.env.GITHUB_STATE, "utf8"), /database-name=ci-db/);
    assert.match(fs.readFileSync(path.join(temp, "calls.log"), "utf8"), /--json create --name ci-db/);
  } finally {
    process.env = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
