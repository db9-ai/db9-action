"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const github = require("../dist/github");
const { apiUrl, cleanupDatabase, normalizeApiUrl, runMain } = require("../dist/db9-action");

const queryError = "DB9 API URL must not include a query string";
const token = "query-test-bearer";
const secret = "query-test-refresh-secret";
const invalidBases = [
  "https://api.db9.ai/customer/databases/db_victim?x=",
  "https://api.db9.ai?",
  "https://api.db9.ai/base/?",
  "https://api.db9.ai/base?/",
  "https://custom.example.test/prefix?token=query-secret",
  "https://custom.example.test/prefix?%3F",
];
const validBases = [
  ["https://api.db9.ai", "https://api.db9.ai"],
  ["https://api.db9.ai///", "https://api.db9.ai"],
  ["https://custom.example.test/base/", "https://custom.example.test/base"],
  [" https://custom.example.test/base/v1/// ", "https://custom.example.test/base/v1"],
  ["https://custom.example.test/base%3Fsegment", "https://custom.example.test/base%3Fsegment"],
  ["https://custom.example.test:8443/base", "https://custom.example.test:8443/base"],
  ["https://[::1]:8443/base/", "https://[::1]:8443/base"],
];

function signedRecord(base, anonymous) {
  const values = {
    created: "true",
    cleanup: "true",
    "database-id": "db_created/id",
    "database-name": "db_victim",
    "api-url": base,
    "anonymous-id": "query-test-anonymous",
  };
  const payload = Buffer.from(JSON.stringify(values)).toString("base64url");
  const signature = crypto.createHmac("sha256", token)
    .update(payload).update("\0").update(anonymous ? secret : "").digest("base64url");
  return `v2.${payload}.${signature}`;
}

async function withEnvironment(anonymous, callback) {
  const previous = { ...process.env };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "db9-query-test-"));
  try {
    for (const name of Object.keys(process.env)) {
      if (/^(INPUT_|STATE_|GITHUB_)/.test(name)) {
        delete process.env[name];
      }
    }
    process.env.GITHUB_OUTPUT = path.join(directory, "output");
    process.env.GITHUB_ENV = path.join(directory, "env");
    process.env.GITHUB_STATE = path.join(directory, "state");
    if (anonymous) {
      process.env["STATE_access-token"] = token;
      process.env["STATE_anonymous-secret"] = secret;
    } else {
      process.env["INPUT_DB9-API-KEY"] = token;
    }
    return await callback(directory);
  } finally {
    process.env = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("API bases reject query strings including an empty query delimiter", () => {
  for (const base of invalidBases) {
    assert.throws(() => normalizeApiUrl(base), { message: queryError });
    assert.throws(() => apiUrl(base, "/customer/databases/db_created"), { message: queryError });
  }
});

test("query-free HTTPS bases preserve custom hosts, prefixes, and request queries", () => {
  assert.equal(normalizeApiUrl(""), "https://api.db9.ai");
  for (const [base, normalized] of validBases) {
    assert.equal(normalizeApiUrl(base), normalized);
    assert.equal(
      apiUrl(base, "/customer/databases?all=true&project_id=project-fixture"),
      `${normalized}/customer/databases?all=true&project_id=project-fixture`,
    );
  }
});

test("main rejects API base queries in every mode before requests or publishing state", async (context) => {
  context.mock.method(github, "setSecret", () => {});
  for (const anonymous of [false, true]) {
    for (const mode of ["database", "branch", "cleanup"]) {
      for (const base of invalidBases) {
        await withEnvironment(anonymous, async (directory) => {
          process.env.INPUT_MODE = mode;
          process.env["INPUT_DB9-API-URL"] = base;
          process.env["INPUT_PROJECT-ID"] = "project-fixture";
          const calls = [];
          await assert.rejects(() => runMain({
            fetchImpl: async (url) => { calls.push(url); throw new Error("Unexpected API request"); },
          }), { message: queryError });
          assert.deepEqual(calls, []);
          for (const file of ["output", "env", "state"]) {
            assert.equal(fs.existsSync(path.join(directory, file)), false);
          }
        });
      }
    }
  }
});

test("post rejects signed API base queries before deletion or anonymous refresh", async (context) => {
  context.mock.method(github, "setSecret", () => {});
  for (const anonymous of [false, true]) {
    for (const base of invalidBases) {
      await withEnvironment(anonymous, async () => {
        process.env["STATE_cleanup-record"] = signedRecord(base, anonymous);
        process.env["INPUT_DB9-API-URL"] = "https://api.db9.ai";
        const calls = [];
        await assert.rejects(() => cleanupDatabase({
          fetchImpl: async (url) => { calls.push(url); throw new Error("Unexpected API request"); },
        }), { message: queryError });
        assert.deepEqual(calls, []);
      });
    }
  }
});

test("post preserves custom prefixes and deletes only the encoded signed database ID", async (context) => {
  context.mock.method(github, "setSecret", () => {});
  context.mock.method(console, "log", () => {});
  for (const anonymous of [false, true]) {
    for (const [base, normalized] of validBases) {
      await withEnvironment(anonymous, async () => {
        process.env["STATE_cleanup-record"] = signedRecord(base, anonymous);
        process.env["INPUT_DB9-API-URL"] = invalidBases[0];
        const calls = [];
        await cleanupDatabase({
          fetchImpl: async (url, options) => {
            calls.push({ url, method: options.method, authorization: options.headers.Authorization });
            return new Response("{}", { status: 200 });
          },
        });
        assert.deepEqual(calls, [{
          url: `${normalized}/customer/databases/db_created%2Fid`,
          method: "DELETE",
          authorization: `Bearer ${token}`,
        }]);
      });
    }
  }
});

test("main and post entry points report fixed query errors without secrets or requests", async () => {
  for (const anonymous of [false, true]) {
    for (const entry of ["index.js", "cleanup.js"]) {
      for (const base of [invalidBases[1], invalidBases[4]]) {
        await withEnvironment(anonymous, async (directory) => {
          process.env["INPUT_DB9-API-URL"] = base;
          process.env["STATE_cleanup-record"] = signedRecord(base, anonymous);
          process.env.TEST_QUERY_REQUESTS = path.join(directory, "requests");
          const result = spawnSync(process.execPath, ["-e", `
            const fs = require("node:fs");
            const github = require("./dist/github");
            github.setSecret = () => {};
            global.fetch = async () => {
              fs.appendFileSync(process.env.TEST_QUERY_REQUESTS, "request");
              throw new Error("Unexpected API request");
            };
            require(process.argv[1]);
          `, path.resolve(__dirname, "../dist", entry)], {
            cwd: path.resolve(__dirname, ".."), env: process.env, encoding: "utf8", timeout: 10000,
          });
          assert.ifError(result.error);
          assert.equal(result.status, entry === "index.js" ? 1 : 0, result.stdout + result.stderr);
          assert.equal(result.stdout.trim(), entry === "index.js"
            ? `::error::${queryError}`
            : `::warning::DB9 cleanup failed: ${queryError}`);
          assert.equal(result.stderr, "");
          assert.equal(fs.existsSync(process.env.TEST_QUERY_REQUESTS), false);
          for (const forbidden of [token, secret, "query-secret", base, process.env["STATE_cleanup-record"]]) {
            assert.equal((result.stdout + result.stderr).includes(forbidden), false);
          }
        });
      }
    }
  }
});
