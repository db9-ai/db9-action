"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildTemporaryConnectionString, cleanupDatabase, runMain } = require("../dist/db9-action");

const connection = {
  user: "db.admin",
  token: "password+value",
  port: 5433,
  database: "postgres",
};

const validHosts = [
  "pg.db9.ai",
  "PG.Db9.AI",
  "pg.db9.ai.",
  "localhost",
  "db-01.example.test",
  "xn--bcher-kva.example",
  "192.0.2.1",
  "0.0.0.0",
  "255.255.255.255",
  "[::1]",
  "[2001:db8::1]",
  "[2001:DB8:0:0:0:0:0:1]",
  "[::ffff:192.0.2.1]",
  "a".repeat(63),
  `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
  `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}.`,
];

const invalidHosts = [
  "pg.db9.ai/postgres?sslmode=disable&host=attacker.example",
  "pg.db9.ai?host=attacker.example",
  "pg.db9.ai#fragment",
  "pg.db9.ai&host=attacker.example",
  "pg.db9.ai:5432",
  "pg.db9.ai,attacker.example",
  "user@pg.db9.ai",
  "/var/run/postgresql",
  "pg.db9.ai\\postgres",
  "pg.db9.ai%2fpostgres",
  "pg.db9.ai%00",
  " pg.db9.ai",
  "pg.db9.ai ",
  "pg db9.ai",
  "pg.db9.ai\u00a0",
  'pg.db9.ai"',
  "pg.db9.ai'",
  "$(touch /tmp/host-injection)",
  "db|cat",
  "db;cat",
  "db=attacker",
  "db_01.example",
  "bücher.example",
  ".example",
  "db..example",
  "-db.example",
  "db-.example",
  ".",
  "a".repeat(64),
  `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
  "999.0.0.1",
  "127.1",
  "192.168.001.1",
  "::1",
  "[127.0.0.1]",
  "[2001:db8:::1]",
  "[::1]:5432",
  "[::1]attacker.example",
  "[fe80::1%eth0]",
  "[fe80::1%25eth0]",
  ...Array.from({ length: 33 }, (_, index) => `pg.db9.ai${String.fromCharCode(index === 32 ? 127 : index)}`),
];

test("connect-token hosts preserve valid DNS names, IPv4, and bracketed IPv6 exactly", () => {
  for (const host of validHosts) {
    const dsn = buildTemporaryConnectionString({ ...connection, host });
    assert.equal(dsn, `postgresql://db.admin:password%2Bvalue@${host}:5433/postgres`);
    const parsed = new URL(dsn);
    assert.equal(parsed.search, "");
    assert.equal(parsed.hash, "");
    assert.equal(parsed.port, "5433");
  }
});

test("connect-token hosts cannot introduce URI components, controls, or invalid host syntax", () => {
  for (const host of invalidHosts) {
    assert.throws(
      () => buildTemporaryConnectionString({ ...connection, host }),
      { message: "Invalid DB9 connect-token response: invalid host" },
      JSON.stringify(host),
    );
  }
});

test("host validation retains missing-field and port errors without reflecting response data", () => {
  for (const host of [undefined, null, "", 123, [], {}]) {
    assert.throws(() => buildTemporaryConnectionString({ ...connection, host }), /missing host/);
  }
  for (const port of [0, 65536, "not-a-port"]) {
    assert.throws(() => buildTemporaryConnectionString({ ...connection, host: "pg.db9.ai", port }), /invalid port/);
  }
  assert.equal(
    buildTemporaryConnectionString({ user: "user@tenant", token: "pass/?#", host: "[::1]", port: "5433", database: "db/name" }),
    "postgresql://user%40tenant:pass%2F%3F%23@[::1]:5433/db%2Fname",
  );
});

test("invalid connect hosts fail before publishing outputs while preserving post cleanup", async (context) => {
  context.mock.method(console, "log", () => {});
  for (const anonymous of [false, true]) {
    for (const mode of ["database", "branch"]) {
      for (const exportEnv of [false, true]) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "db9-connect-host-"));
        const previous = { ...process.env };
        const calls = [];
        try {
          for (const name of Object.keys(process.env)) {
            if (/^(INPUT_|STATE_|GITHUB_)/.test(name) || name === "DATABASE_URL" || name === "DB9_DATABASE_URL") {
              delete process.env[name];
            }
          }
          process.env.GITHUB_OUTPUT = path.join(directory, "output");
          process.env.GITHUB_ENV = path.join(directory, "env");
          process.env.GITHUB_STATE = path.join(directory, "state");
          process.env.INPUT_MODE = mode;
          process.env.INPUT_WAIT = "false";
          process.env.INPUT_CLEANUP = "true";
          process.env["INPUT_DATABASE-NAME"] = "host-check";
          process.env["INPUT_EXPORT-ENV"] = String(exportEnv);
          process.env["INPUT_PROJECT-ID"] = "project-fixture";
          process.env["INPUT_SOURCE-DATABASE-ID"] = "db_source";
          if (!anonymous) {
            process.env["INPUT_DB9-API-KEY"] = "account-key";
          }
          const routes = {
            "POST /customer/anonymous-register": { token: "anon-token", anonymous_id: "anon-id", anonymous_secret: "anon-secret" },
            "GET /customer/databases": [{ id: "db_source", project_id: "project-fixture" }],
            "POST /customer/databases": { id: "db_created", name: "host-check", state: "ACTIVE" },
            "POST /customer/databases/db_source/branch": { id: "db_created", name: "host-check", state: "ACTIVE" },
            "POST /customer/databases/db_created/connect-token": { ...connection, host: invalidHosts[0] },
            "DELETE /customer/databases/db_created": {},
          };
          const fetchImpl = async (url, options) => {
            const key = `${options.method} ${new URL(url).pathname}`;
            calls.push(key);
            assert.ok(Object.hasOwn(routes, key), key);
            assert.equal(new URL(url).origin, "https://api.db9.ai");
            return new Response(JSON.stringify(routes[key]), { status: 200 });
          };
          await assert.rejects(() => runMain({ fetchImpl }), {
            message: "Invalid DB9 connect-token response: invalid host",
          });
          assert.ok(!fs.existsSync(process.env.GITHUB_OUTPUT));
          assert.ok(!fs.existsSync(process.env.GITHUB_ENV));
          assert.equal(process.env.DATABASE_URL, undefined);
          assert.equal(process.env.DB9_DATABASE_URL, undefined);
          assert.equal(calls.at(-1), "POST /customer/databases/db_created/connect-token");
          const state = fs.readFileSync(process.env.GITHUB_STATE, "utf8");
          for (const entry of state.trimEnd().split(/\r?\n/)) {
            const separator = entry.indexOf("=");
            process.env[`STATE_${entry.slice(0, separator)}`] = entry.slice(separator + 1);
          }
          const beforeCleanup = calls.length;
          await cleanupDatabase({ fetchImpl });
          assert.deepEqual(calls.slice(beforeCleanup), ["DELETE /customer/databases/db_created"]);
        } finally {
          process.env = previous;
          fs.rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }
});
