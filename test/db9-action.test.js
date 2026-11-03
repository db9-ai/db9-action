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
    const key = `${options.method || "GET"} ${parsed.pathname}${parsed.search}`;
    const keyWithoutSearch = `${options.method || "GET"} ${parsed.pathname}`;
    const call = {
      key,
      url,
      body: options.body ? JSON.parse(options.body) : undefined,
      headers: options.headers || {},
    };
    calls.push(call);
    let route = routes[key] || routes[keyWithoutSearch];
    if (!route) {
      return new Response(JSON.stringify({ message: `unexpected route: ${key}` }), { status: 404 });
    }
    if (Array.isArray(route)) {
      route = route.length > 1 ? route.shift() : route[0];
    }
    if (typeof route === "function") {
      route = route(call);
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

test("generateDatabaseName supports prefixes and worker IDs", () => {
  const name = generateDatabaseName(
    {
      GITHUB_REPOSITORY: "db9-ai/example-app",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "2",
    },
    { prefix: "ci", workerId: "node-24" },
  );
  assert.equal(name, "ci-example-app-12345-2-node-24");
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

test("runMain creates an anonymous database through the DB9 API", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(line));
  await withGithubFiles(async () => {
    process.env["INPUT_DATABASE-NAME"] = "ci-db";
    process.env.INPUT_CLEANUP = "true";
    delete process.env["INPUT_DB9-API-URL"];
    process.env.INPUT_DB9_API_URL = "https://unrelated.example.test";

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

    assert.ok(logs.includes("::add-mask::sub_123"));
    assert.ok(logs.includes("::add-mask::anon-token"));
    assert.ok(logs.includes("::add-mask::anon-secret"));
    assert.deepEqual(calls.map((call) => call.key), [
      "POST /customer/anonymous-register",
      "POST /customer/databases",
      "POST /customer/databases/db_123/connect-token",
    ]);
    assert.ok(calls.every((call) => new URL(call.url).origin === "https://api.db9.ai"));
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
    for (const line of state.trimEnd().split(/\r?\n/)) {
      const separator = line.indexOf("=");
      process.env[`STATE_${line.slice(0, separator)}`] = line.slice(separator + 1);
    }
    const record = process.env["STATE_cleanup-record"];
    const [version, payload] = record.split(".");
    assert.equal(version, "v2");
    const values = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    assert.equal(values["access-token"], undefined);
    assert.equal(values["anonymous-secret"], undefined);
    assert.ok(!Buffer.from(payload, "base64url").toString("utf8").includes("anon-token"));
    assert.ok(!Buffer.from(payload, "base64url").toString("utf8").includes("anon-secret"));

    const rejectedCalls = [];
    process.env["STATE_anonymous-secret"] = "modified-secret";
    await cleanupDatabase({ fetchImpl: mockFetch({}, rejectedCalls) });
    assert.deepEqual(rejectedCalls, []);

    process.env["STATE_anonymous-secret"] = "anon-secret";
    const cleanupCalls = [];
    await cleanupDatabase({
      fetchImpl: mockFetch({
        "DELETE /customer/databases/db_123": [
          { status: 401, body: { message: "expired" } },
          { status: 200, body: {} },
        ],
        "POST /customer/anonymous-refresh": { body: { token: "refreshed-token" } },
      }, cleanupCalls),
    });
    assert.deepEqual(cleanupCalls.map((call) => call.key), [
      "DELETE /customer/databases/db_123",
      "POST /customer/anonymous-refresh",
      "DELETE /customer/databases/db_123",
    ]);
    assert.equal(cleanupCalls[0].headers.Authorization, "Bearer anon-token");
    assert.equal(cleanupCalls[2].headers.Authorization, "Bearer refreshed-token");
  });
});

test("runMain uses db9-api-key without anonymous registration", async () => {
  await withGithubFiles(async () => {
    process.env["INPUT_DB9-API-KEY"] = "api-key";
    process.env["INPUT_DATABASE-NAME"] = "ci-db";
    process.env["INPUT_DB9-API-URL"] = "https://custom.example.test";

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
    assert.ok(calls.every((call) => new URL(call.url).origin === "https://custom.example.test"));
    const state = fs.readFileSync(process.env.GITHUB_STATE, "utf8");
    const record = state.split(/\r?\n/).find((line) => line.startsWith("cleanup-record=")).slice("cleanup-record=".length);
    const [version, payload] = record.split(".");
    assert.equal(version, "v2");
    assert.ok(!Buffer.from(payload, "base64url").toString("utf8").includes("api-key"));
    for (const line of state.trimEnd().split(/\r?\n/)) {
      const separator = line.indexOf("=");
      process.env[`STATE_${line.slice(0, separator)}`] = line.slice(separator + 1);
    }
    process.env["STATE_anonymous-secret"] = "unrelated-state";
    const cleanupCalls = [];
    await cleanupDatabase({
      fetchImpl: mockFetch({ "DELETE /customer/databases/db_123": { body: {} } }, cleanupCalls),
    });
    assert.deepEqual(cleanupCalls.map((call) => call.key), ["DELETE /customer/databases/db_123"]);
    assert.equal(cleanupCalls[0].headers.Authorization, "Bearer api-key");
  });
});

test("runMain creates a branch and waits until ACTIVE", async () => {
  await withGithubFiles(async () => {
    process.env["INPUT_DB9-API-KEY"] = "api-key";
    process.env.INPUT_MODE = "branch";
    process.env["INPUT_PROJECT-ID"] = "project-1";
    process.env["INPUT_SOURCE-DATABASE-ID"] = "db_source";
    process.env["INPUT_SOURCE-DATABASE-NAME"] = "ignored";
    process.env["INPUT_DATABASE-NAME"] = "ci-branch";
    process.env["INPUT_SNAPSHOT-AT"] = "2026-07-04T03:30:00Z";

    const calls = [];
    const fetchImpl = mockFetch(
      {
        "GET /customer/databases?all=true&project_id=project-1": {
          status: 200,
          body: [{ id: "db_source", name: "staging", project_id: "project-1" }],
        },
        "POST /customer/databases/db_source/branch": {
          status: 201,
          body: {
            id: "db_branch",
            name: "ci-branch",
            state: "CLONING",
            parent_database_id: "db_source",
          },
        },
        "GET /customer/databases/db_branch": {
          status: 200,
          body: { id: "db_branch", name: "ci-branch", state: "ACTIVE" },
        },
        "POST /customer/databases/db_branch/connect-token": {
          status: 201,
          body: {
            user: "db_branch.admin",
            token: "connect-token",
            host: "pg.db9.ai",
            port: 5433,
            database: "postgres",
          },
        },
      },
      calls,
    );

    await runMain({ fetchImpl, pollIntervalMs: 1 });

    assert.deepEqual(calls.map((call) => call.key), [
      "GET /customer/databases?all=true&project_id=project-1",
      "POST /customer/databases/db_source/branch",
      "GET /customer/databases/db_branch",
      "POST /customer/databases/db_branch/connect-token",
    ]);
    assert.deepEqual(calls[1].body, { name: "ci-branch", snapshot_at: "2026-07-04T03:30:00Z" });

    const output = fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8");
    assert.match(output, /database-id=db_branch/);
    assert.match(output, /database-state=ACTIVE/);
  });
});

test("runMain resolves branch source by database name", async () => {
  await withGithubFiles(async () => {
    process.env["INPUT_DB9-API-KEY"] = "api-key";
    process.env.INPUT_MODE = "branch";
    process.env["INPUT_PROJECT-ID"] = "project-1";
    process.env["INPUT_SOURCE-DATABASE-NAME"] = "staging";
    process.env["INPUT_DATABASE-NAME"] = "ci-branch";
    process.env.INPUT_WAIT = "false";

    const calls = [];
    const fetchImpl = mockFetch(
      {
        "GET /customer/databases?all=true&project_id=project-1": {
          status: 200,
          body: [
            { id: "db_other", name: "staging", project_id: "project-2" },
            { id: "db_source", name: "staging", state: "ACTIVE", project_id: "project-1" },
          ],
        },
        "POST /customer/databases/db_source/branch": {
          status: 201,
          body: { id: "db_branch", name: "ci-branch", state: "CLONING" },
        },
        "POST /customer/databases/db_branch/connect-token": {
          status: 201,
          body: {
            user: "db_branch.admin",
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
      "GET /customer/databases?all=true&project_id=project-1",
      "POST /customer/databases/db_source/branch",
      "POST /customer/databases/db_branch/connect-token",
    ]);
  });
});

test("branch mode requires a project before any API request", async () => {
  await withGithubFiles(async () => {
    process.env.INPUT_MODE = "branch";
    process.env["INPUT_SOURCE-DATABASE-ID"] = "db_source";
    delete process.env["INPUT_DB9-API-KEY"];
    delete process.env["INPUT_PROJECT-ID"];

    const calls = [];
    await assert.rejects(() => runMain({ fetchImpl: mockFetch({}, calls) }), /branch mode requires project-id/);
    assert.deepEqual(calls, []);
  });
});

test("branch mode rejects sources outside the project before creating a branch", async () => {
  for (const sourceInput of ["INPUT_SOURCE-DATABASE-ID", "INPUT_SOURCE-DATABASE-NAME"]) {
    await withGithubFiles(async () => {
      process.env["INPUT_DB9-API-KEY"] = "api-key";
      process.env.INPUT_MODE = "branch";
      process.env["INPUT_PROJECT-ID"] = "project-1";
      process.env[sourceInput] = sourceInput.endsWith("-ID") ? "db_other" : "staging";
      const calls = [];
      const fetchImpl = mockFetch({
        "GET /customer/databases?all=true&project_id=project-1": {
          body: [
            { id: "db_other", name: "staging", project_id: "project-2" },
            { id: "db_unscoped", name: "staging" },
          ],
        },
      }, calls);

      await assert.rejects(() => runMain({ fetchImpl }), /source database in the specified project/);
      assert.deepEqual(calls.map((call) => call.key), ["GET /customer/databases?all=true&project_id=project-1"]);
    });
  }
});

test("branch mode rejects an unknown source without creating a branch", async () => {
  await withGithubFiles(async () => {
    process.env["INPUT_DB9-API-KEY"] = "api-key";
    process.env.INPUT_MODE = "branch";
    process.env["INPUT_PROJECT-ID"] = "project-1";
    process.env["INPUT_SOURCE-DATABASE-NAME"] = "missing";
    const calls = [];
    const fetchImpl = mockFetch({
      "GET /customer/databases?all=true&project_id=project-1": { body: [] },
    }, calls);

    await assert.rejects(() => runMain({ fetchImpl }), /source database in the specified project/);
    assert.deepEqual(calls.map((call) => call.key), ["GET /customer/databases?all=true&project_id=project-1"]);
  });
});

test("runMain cleanup mode deletes databases by prefix", async () => {
  await withGithubFiles(async () => {
    process.env["INPUT_DB9-API-KEY"] = "api-key";
    process.env.INPUT_MODE = "cleanup";
    process.env["INPUT_PROJECT-ID"] = "project-1";
    process.env["INPUT_CLEANUP-PREFIX"] = "ci-";

    const calls = [];
    const fetchImpl = mockFetch(
      {
        "GET /customer/databases?all=true&project_id=project-1": {
          status: 200,
          body: [
            { id: "db_1", name: "ci-123", project_id: "project-1" },
            { id: "db_2", name: "keep-me", project_id: "project-1" },
            { id: "db_3", name: "ci-456", project_id: "project-1" },
            { id: "db_4", name: "ci-outside", project_id: "project-2" },
            { id: "db_5", name: "ci-unscoped" },
          ],
        },
        "DELETE /customer/databases/db_1": { status: 200, body: {} },
        "DELETE /customer/databases/db_3": { status: 200, body: {} },
      },
      calls,
    );

    await runMain({ fetchImpl });

    assert.deepEqual(calls.map((call) => call.key), [
      "GET /customer/databases?all=true&project_id=project-1",
      "DELETE /customer/databases/db_1",
      "DELETE /customer/databases/db_3",
    ]);
    const output = fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8");
    assert.match(output, /cleanup-count=2/);
  });
});

test("cleanup mode requires a project before any API request", async () => {
  await withGithubFiles(async () => {
    process.env.INPUT_MODE = "cleanup";
    process.env["INPUT_CLEANUP-PREFIX"] = "ci-";
    delete process.env["INPUT_PROJECT-ID"];
    delete process.env["INPUT_DB9-API-KEY"];
    const calls = [];

    await assert.rejects(() => runMain({ fetchImpl: mockFetch({}, calls) }), /cleanup mode requires project-id/);
    assert.deepEqual(calls, []);
  });
});

test("cleanup mode does not delete nonmatching or out-of-project databases", async () => {
  await withGithubFiles(async () => {
    process.env["INPUT_DB9-API-KEY"] = "api-key";
    process.env.INPUT_MODE = "cleanup";
    process.env["INPUT_PROJECT-ID"] = "project-1";
    process.env["INPUT_CLEANUP-PREFIX"] = "ci-";
    const calls = [];
    const fetchImpl = mockFetch({
      "GET /customer/databases?all=true&project_id=project-1": {
        body: [
          { id: "db_1", name: "keep-me", project_id: "project-1" },
          { id: "db_2", name: "ci-other", project_id: "project-2" },
        ],
      },
    }, calls);

    await runMain({ fetchImpl });

    assert.deepEqual(calls.map((call) => call.key), ["GET /customer/databases?all=true&project_id=project-1"]);
    assert.match(fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8"), /cleanup-count=0/);
  });
});

test("cleanup mode rejects a matching database without an ID before deleting anything", async () => {
  await withGithubFiles(async () => {
    process.env["INPUT_DB9-API-KEY"] = "api-key";
    process.env.INPUT_MODE = "cleanup";
    process.env["INPUT_PROJECT-ID"] = "project-1";
    process.env["INPUT_CLEANUP-PREFIX"] = "ci-";
    const calls = [];
    const fetchImpl = mockFetch({
      "GET /customer/databases?all=true&project_id=project-1": {
        body: [
          { id: "db_1", name: "ci-valid", project_id: "project-1" },
          { name: "ci-missing-id", project_id: "project-1" },
        ],
      },
    }, calls);

    await assert.rejects(() => runMain({ fetchImpl }), /cleanup target is missing a database ID/);
    assert.deepEqual(calls.map((call) => call.key), ["GET /customer/databases?all=true&project_id=project-1"]);
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

test("cleanupDatabase uses the signed cleanup record instead of modified individual state", async () => {
  await withGithubFiles(async () => {
    process.env.STATE_created = "true";
    process.env.STATE_cleanup = "true";
    process.env["STATE_database-id"] = "db_forged";
    process.env["STATE_api-url"] = "https://attacker.example.test";
    process.env["STATE_access-token"] = "anon-token";

    const values = {
      created: "true",
      cleanup: "true",
      "database-name": "ci-db",
      "database-id": "db_123",
      "api-url": "https://api.db9.ai",
      "access-token": "anon-token",
    };
    const payload = Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
    const signature = require("node:crypto").createHmac("sha256", "anon-token").update(payload).digest("base64url");
    process.env["STATE_cleanup-record"] = `${payload}.${signature}`;

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
    assert.ok(calls.every((call) => new URL(call.url).origin === "https://api.db9.ai"));
    assert.equal(calls[0].headers.Authorization, "Bearer anon-token");
  });
});

test("cleanupDatabase rejects a cleanup record signed by a different token", async () => {
  await withGithubFiles(async () => {
    process.env.STATE_created = "true";
    process.env.STATE_cleanup = "true";
    process.env["STATE_database-id"] = "db_123";
    process.env["STATE_api-url"] = "https://api.db9.ai";
    process.env["STATE_access-token"] = "anon-token";

    const values = {
      created: "true",
      cleanup: "true",
      "database-name": "ci-db",
      "database-id": "db_forged",
      "api-url": "https://attacker.example.test",
      "access-token": "other-token",
    };
    const payload = Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
    const signature = require("node:crypto").createHmac("sha256", "other-token").update(payload).digest("base64url");
    process.env["STATE_cleanup-record"] = `${payload}.${signature}`;

    const calls = [];
    await cleanupDatabase({
      fetchImpl: mockFetch({}, calls),
    });

    assert.deepEqual(calls, []);
  });
});

test("apiUrl keeps a custom https base path and rejects unsafe URLs", () => {
  assert.equal(
    apiUrl("https://custom.example.test/base/", "/customer/databases"),
    "https://custom.example.test/base/customer/databases",
  );
  assert.throws(() => apiUrl("http://attacker.example", "/customer/databases"), /https/);
  assert.throws(() => apiUrl("https://user:secret@api.db9.ai", "/customer/databases"), /credentials/);
  assert.throws(() => apiUrl("https://api.db9.ai/#fragment", "/customer/databases"), /fragment/);
});

test("runMain rejects a non-https API URL before sending the API key", async () => {
  await withGithubFiles(async () => {
    process.env["INPUT_DB9-API-KEY"] = "api-key";
    process.env["INPUT_DATABASE-NAME"] = "ci-db";
    process.env["INPUT_DB9-API-URL"] = "http://attacker.example/db";
    const calls = [];
    await assert.rejects(
      () => runMain({ fetchImpl: async (url) => { calls.push(url); return new Response("{}"); } }),
      /https/,
    );
    assert.deepEqual(calls, []);
  });
});

test("requestJson asks fetch not to follow redirects", async () => {
  let seen;
  await requestJson("GET", "https://api.db9.ai", "/customer/databases", {
    token: "api-key",
    fetchImpl: async (_url, options) => {
      seen = options;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(seen.redirect, "error");
  assert.equal(seen.headers.Authorization, "Bearer api-key");
});
