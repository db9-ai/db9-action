"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  apiUrl,
  buildTemporaryConnectionString,
  cleanupDatabase,
  generateDatabaseName,
  requestJson,
  runMain,
  sanitizeDatabaseName,
} = require("../dist/db9-action");

function mockFetch(routes, calls = []) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const key = `${options.method || "GET"} ${parsed.pathname}`;
    calls.push({
      key,
      url,
      body: options.body ? JSON.parse(options.body) : undefined,
      headers: options.headers || {},
    });
    const route = routes[key];
    if (!route) {
      return new Response(JSON.stringify({ message: `unexpected route: ${key}` }), { status: 404 });
    }
    return new Response(JSON.stringify(route.body || {}), {
      status: route.status || 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function withGithubFiles(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "db9-action-test-"));
  const previous = { ...process.env };
  try {
    process.env.GITHUB_REPOSITORY = "db9-ai/example";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_RUN_ATTEMPT = "1";
    process.env.GITHUB_OUTPUT = path.join(temp, "output");
    process.env.GITHUB_ENV = path.join(temp, "env");
    process.env.GITHUB_STATE = path.join(temp, "state");
    return await fn(temp);
  } finally {
    process.env = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

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

test("apiUrl joins base URL and path", () => {
  assert.equal(apiUrl("https://api.db9.ai/", "/customer/databases"), "https://api.db9.ai/customer/databases");
});

test("buildTemporaryConnectionString percent-encodes user info", () => {
  const dsn = buildTemporaryConnectionString({
    user: "tenant.admin",
    token: "jwt+token=value",
    host: "pg.db9.ai",
    port: 5433,
    database: "postgres",
  });
  assert.equal(dsn, "postgresql://tenant.admin:jwt%2Btoken%3Dvalue@pg.db9.ai:5433/postgres");
});

test("requestJson reports API errors", async () => {
  await assert.rejects(
    () =>
      requestJson("POST", "https://api.db9.ai", "/customer/databases", {
        fetchImpl: mockFetch({
          "POST /customer/databases": { status: 409, body: { message: "Database name already exists" } },
        }),
      }),
    /Database name already exists/,
  );
});

test("runMain creates an anonymous database through the DB9 API", async () => {
  await withGithubFiles(async () => {
    process.env["INPUT_DATABASE-NAME"] = "ci-db";
    process.env.INPUT_CLEANUP = "true";

    const calls = [];
    const fetchImpl = mockFetch(
      {
        "POST /customer/anonymous-register": {
          status: 200,
          body: {
            token: "anon-token",
            anonymous_id: "sub_123",
            anonymous_secret: "anon-secret",
          },
        },
        "POST /customer/databases": {
          status: 201,
          body: { id: "db_123", name: "ci-db" },
        },
        "POST /customer/databases/db_123/connect-token": {
          status: 201,
          body: {
            user: "db_123.admin",
            token: "connect-token",
            host: "pg.db9.ai",
            port: 5433,
            database: "postgres",
            expires_at: "2026-07-04T03:30:00Z",
            expires_in_seconds: 900,
          },
        },
      },
      calls,
    );

    await runMain({ fetchImpl });

    assert.deepEqual(calls.map((call) => call.key), [
      "POST /customer/anonymous-register",
      "POST /customer/databases",
      "POST /customer/databases/db_123/connect-token",
    ]);
    assert.equal(calls[1].headers.Authorization, "Bearer anon-token");
    assert.deepEqual(calls[1].body, { name: "ci-db" });

    const output = fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8");
    assert.match(output, /database-url=postgresql:\/\/db_123.admin:connect-token@pg.db9.ai:5433\/postgres/);
    assert.match(output, /database-id=db_123/);
    assert.match(output, /expires-at=2026-07-04T03:30:00Z/);

    const env = fs.readFileSync(process.env.GITHUB_ENV, "utf8");
    assert.match(env, /DATABASE_URL=postgresql:\/\/db_123.admin:connect-token@pg.db9.ai:5433\/postgres/);

    const state = fs.readFileSync(process.env.GITHUB_STATE, "utf8");
    assert.match(state, /access-token=anon-token/);
    assert.match(state, /anonymous-secret=anon-secret/);
  });
});

test("runMain uses db9-api-key without anonymous registration", async () => {
  await withGithubFiles(async () => {
    process.env["INPUT_DB9-API-KEY"] = "api-key";
    process.env["INPUT_DATABASE-NAME"] = "ci-db";

    const calls = [];
    const fetchImpl = mockFetch(
      {
        "POST /customer/databases": {
          status: 201,
          body: { id: "db_123", name: "ci-db" },
        },
        "POST /customer/databases/db_123/connect-token": {
          status: 201,
          body: {
            user: "db_123.admin",
            token: "connect-token",
            host: "pg.db9.ai",
            port: 5433,
            database: "postgres",
          },
        },
      },
      calls,
    );

    await runMain({ fetchImpl });

    assert.deepEqual(calls.map((call) => call.key), [
      "POST /customer/databases",
      "POST /customer/databases/db_123/connect-token",
    ]);
    assert.equal(calls[0].headers.Authorization, "Bearer api-key");
  });
});

test("cleanupDatabase deletes the recorded database through the DB9 API", async () => {
  await withGithubFiles(async () => {
    process.env.STATE_created = "true";
    process.env.STATE_cleanup = "true";
    process.env["STATE_database-id"] = "db_123";
    process.env["STATE_access-token"] = "anon-token";
    process.env["STATE_api-url"] = "https://api.db9.ai";

    const calls = [];
    await cleanupDatabase({
      fetchImpl: mockFetch(
        {
          "DELETE /customer/databases/db_123": {
            status: 200,
            body: { message: "Database disabled" },
          },
        },
        calls,
      ),
    });

    assert.deepEqual(calls.map((call) => call.key), ["DELETE /customer/databases/db_123"]);
    assert.equal(calls[0].headers.Authorization, "Bearer anon-token");
  });
});
