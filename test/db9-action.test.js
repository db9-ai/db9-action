"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const github = require("../dist/github");
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

function signedCleanupRecord(values, token = "anon-token", anonymousSecret = "") {
  const payload = Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", token)
    .update(payload)
    .update("\0")
    .update(anonymousSecret)
    .digest("base64url");
  return `v2.${payload}.${signature}`;
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

test("long generated names keep distinct run, attempt, worker, repository, and prefix identities", () => {
  const env = {
    GITHUB_REPOSITORY: `db9-ai/${"example".repeat(12)}`,
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const options = { prefix: "ci".repeat(40), workerId: "worker".repeat(15) };
  const names = [
    generateDatabaseName(env, options),
    generateDatabaseName({ ...env, GITHUB_RUN_ID: "12346" }, options),
    generateDatabaseName({ ...env, GITHUB_RUN_ATTEMPT: "2" }, options),
    generateDatabaseName(env, { ...options, workerId: `${options.workerId}-2` }),
    generateDatabaseName({ ...env, GITHUB_REPOSITORY: `${env.GITHUB_REPOSITORY}-2` }, options),
    generateDatabaseName(env, { ...options, prefix: `${options.prefix}-2` }),
  ];
  assert.equal(new Set(names).size, names.length);
  assert.equal(generateDatabaseName(env, options), names[0]);
  for (const name of names) {
    assert.ok(name.length <= 63);
    assert.match(name, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  }
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
    assert.deepEqual(state.trimEnd().split(/\r?\n/).map((line) => line.slice(0, line.indexOf("="))).sort(),
      ["access-token", "anonymous-secret", "cleanup-record"]);
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
    assert.doesNotMatch(state, /^access-token=/m);
    assert.doesNotMatch(state, /^anonymous-secret=/m);
    assert.deepEqual(state.trimEnd().split(/\r?\n/).map((line) => line.slice(0, line.indexOf("="))), ["cleanup-record"]);
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

test("connection passwords and encoded forms are masked without changing outputs", async (t) => {
  const secrets = [];
  t.mock.method(github, "setSecret", (value) => secrets.push(value));
  t.mock.method(console, "log", () => {});
  const passwords = [
    { token: "plain-token", encoded: "plain-token" },
    { token: "jwt+token=value%2F", encoded: "jwt%2Btoken%3Dvalue%252F" },
    { token: "p@ss:/?#[]!$&'()*", encoded: "p%40ss%3A%2F%3F%23%5B%5D%21%24%26%27%28%29%2A" },
    { token: "multi\nline\rpass%", encoded: "multi%0Aline%0Dpass%25" },
  ];
  for (const { token, encoded } of passwords) {
    await withGithubFiles(async () => {
      process.env["INPUT_DB9-API-KEY"] = "api-key";
      process.env["INPUT_DATABASE-NAME"] = "ci-db";
      secrets.length = 0;
      const calls = [];
      const fetchImpl = mockFetch({
        "POST /customer/databases": { body: { id: "db_123", name: "ci-db", state: "ACTIVE" } },
        "POST /customer/databases/db_123/connect-token": {
          body: { user: "db_123.admin", token, host: "pg.db9.ai", port: 5433, database: "postgres" },
        },
      }, calls);

      await runMain({ fetchImpl });

      const databaseUrl = `postgresql://db_123.admin:${encoded}@pg.db9.ai:5433/postgres`;
      assert.ok(secrets.includes(token), "raw database password must be masked");
      assert.ok(secrets.includes(encoded), "encoded database password must be masked");
      assert.ok(secrets.includes(databaseUrl), "complete database URL must remain masked");
      const output = fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8").split(/\r?\n/);
      assert.ok(output.includes(`database-url=${databaseUrl}`));
      const env = fs.readFileSync(process.env.GITHUB_ENV, "utf8").split(/\r?\n/);
      assert.ok(env.includes(`DATABASE_URL=${databaseUrl}`));
      assert.ok(env.includes(`DB9_DATABASE_URL=${databaseUrl}`));
      assert.deepEqual(calls.map((call) => call.key), [
        "POST /customer/databases", "POST /customer/databases/db_123/connect-token",
      ]);
      assert.deepEqual(calls[0].body, { name: "ci-db" });
      assert.deepEqual(calls[1].body, { role: "admin" });
      assert.equal(calls[1].headers.Authorization, "Bearer api-key");
    });
  }
});

test("runMain rejects missing or invalid created IDs before polling or connecting by name", async () => {
  for (const mode of ["database", "branch"]) {
    for (const databaseId of [undefined, null, "", "   ", 123, {}]) {
      await withGithubFiles(async () => {
        process.env["INPUT_DB9-API-KEY"] = "api-key";
        process.env.INPUT_MODE = mode;
        process.env["INPUT_PROJECT-ID"] = "project-1";
        process.env["INPUT_SOURCE-DATABASE-ID"] = "db_source";
        process.env["INPUT_DATABASE-NAME"] = "shared-name";
        const calls = [];
        const createPath = mode === "branch"
          ? "POST /customer/databases/db_source/branch"
          : "POST /customer/databases";
        const fetchImpl = mockFetch({
          "GET /customer/databases?all=true&project_id=project-1": {
            body: [{ id: "db_source", name: "staging", project_id: "project-1" }],
          },
          [createPath]: { body: { id: databaseId, name: "shared-name", state: "CREATING" } },
        }, calls);

        await assert.rejects(() => runMain({ fetchImpl, pollIntervalMs: 1 }), /missing a database ID/);
        assert.deepEqual(calls.map((call) => call.key), mode === "branch"
          ? ["GET /customer/databases?all=true&project_id=project-1", createPath]
          : [createPath]);
        assert.ok(!fs.existsSync(process.env.GITHUB_STATE));
      });
    }
  }
});

for (const failure of ["timeout", "terminal", "poll-error"]) {
  test(`runMain preserves cleanup state after an ACTIVE wait ${failure}`, async (context) => {
    context.mock.method(console, "log", () => {});
    for (const mode of ["database", "branch"]) {
      for (const anonymous of [false, true]) {
        for (const cleanup of [true, false]) {
          await withGithubFiles(async () => {
            if (anonymous) {
              delete process.env["INPUT_DB9-API-KEY"];
            } else {
              process.env["INPUT_DB9-API-KEY"] = "api-key";
            }
            process.env.INPUT_MODE = mode;
            process.env.INPUT_CLEANUP = String(cleanup);
            process.env["INPUT_PROJECT-ID"] = "project-1";
            process.env["INPUT_SOURCE-DATABASE-ID"] = "db_source";
            process.env["INPUT_DATABASE-NAME"] = "shared-name";
            process.env["INPUT_WAIT-TIMEOUT-SECONDS"] = "1";
            const calls = [];
            const createPath = mode === "branch"
              ? "POST /customer/databases/db_source/branch"
              : "POST /customer/databases";
            const fetchImpl = mockFetch({
              "POST /customer/anonymous-register": {
                body: { token: "anon-token", anonymous_id: "sub_123", anonymous_secret: "anon-secret" },
              },
              "GET /customer/databases?all=true&project_id=project-1": {
                body: [{ id: "db_source", name: "staging", project_id: "project-1" }],
              },
              [createPath]: { body: { id: "db_created", name: "shared-name", state: "CREATING" } },
              "GET /customer/databases/db_created": failure === "terminal"
                ? { body: { id: "db_created", state: "FAILED" } }
                : { status: 503, body: { message: "status poll unavailable" } },
            }, calls);
            let clock;
            if (failure === "timeout") {
              let now = 0;
              clock = context.mock.method(Date, "now", () => { now += 1000; return now; });
            }
            const expectedError = failure === "timeout"
              ? /Timed out waiting/
              : failure === "terminal" ? /reached FAILED/ : /status poll unavailable/;
            try {
              await assert.rejects(() => runMain({ fetchImpl, pollIntervalMs: 1 }), expectedError);
            } finally {
              if (clock) {
                clock.mock.restore();
              }
            }
            const expectedCalls = [
              ...(anonymous ? ["POST /customer/anonymous-register"] : []),
              ...(mode === "branch" ? ["GET /customer/databases?all=true&project_id=project-1"] : []),
              createPath,
              ...(failure === "timeout" ? [] : ["GET /customer/databases/db_created"]),
            ];
            assert.deepEqual(calls.map((call) => call.key), expectedCalls);
            assert.ok(!fs.existsSync(process.env.GITHUB_OUTPUT));
            assert.ok(!fs.existsSync(process.env.GITHUB_ENV));
            assert.ok(fs.existsSync(process.env.GITHUB_STATE), "cleanup state must be saved before the ACTIVE wait");
            const state = fs.readFileSync(process.env.GITHUB_STATE, "utf8");
            const lines = state.trimEnd().split(/\r?\n/);
            assert.deepEqual(lines.map((line) => line.slice(0, line.indexOf("="))).sort(),
              anonymous ? ["access-token", "anonymous-secret", "cleanup-record"] : ["cleanup-record"]);
            for (const line of lines) {
              const separator = line.indexOf("=");
              process.env[`STATE_${line.slice(0, separator)}`] = line.slice(separator + 1);
            }
            const token = anonymous ? "anon-token" : "api-key";
            const values = {
              created: "true",
              cleanup: String(cleanup),
              "database-name": "shared-name",
              "database-id": "db_created",
              "api-url": "https://api.db9.ai",
              ...(anonymous ? { "anonymous-id": "sub_123" } : {}),
            };
            const record = process.env["STATE_cleanup-record"];
            assert.equal(record, signedCleanupRecord(values, token, anonymous ? "anon-secret" : ""));
            assert.ok(!JSON.stringify(values).includes(token));
            assert.ok(!state.includes("api-key"));
            process.env["STATE_database-id"] = "db_source";
            process.env["STATE_cleanup-record"] = `${record}modified`;
            const rejectedCalls = [];
            await cleanupDatabase({ fetchImpl: mockFetch({}, rejectedCalls) });
            assert.deepEqual(rejectedCalls, []);
            process.env["STATE_cleanup-record"] = record;
            const cleanupCalls = [];
            await cleanupDatabase({
              fetchImpl: mockFetch({
                "DELETE /customer/databases/db_created": anonymous
                  ? [{ status: 401, body: { message: "expired" } }, { body: {} }]
                  : { body: {} },
                "POST /customer/anonymous-refresh": { body: { token: "refreshed-token" } },
              }, cleanupCalls),
            });
            assert.deepEqual(cleanupCalls.map((call) => call.key), !cleanup ? [] : anonymous
              ? ["DELETE /customer/databases/db_created", "POST /customer/anonymous-refresh", "DELETE /customer/databases/db_created"]
              : ["DELETE /customer/databases/db_created"]);
            if (cleanup) {
              assert.equal(cleanupCalls[0].headers.Authorization, `Bearer ${token}`);
              if (anonymous) {
                assert.equal(cleanupCalls[2].headers.Authorization, "Bearer refreshed-token");
              }
            }
          });
        }
      }
    }
  });
}

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
          body: { id: "db_branch", name: "ready-branch", state: "ACTIVE" },
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
    assert.match(output, /database-name=ready-branch/);
    assert.match(output, /database-state=ACTIVE/);
    const records = fs.readFileSync(process.env.GITHUB_STATE, "utf8").trimEnd().split(/\r?\n/);
    assert.equal(records.length, 2);
    for (const [index, name] of ["ci-branch", "ready-branch"].entries()) {
      assert.equal(records[index], `cleanup-record=${signedCleanupRecord({
        created: "true",
        cleanup: "true",
        "database-name": name,
        "database-id": "db_branch",
        "api-url": "https://api.db9.ai",
      }, "api-key")}`);
    }
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
    process.env["STATE_access-token"] = "anon-token";
    process.env["STATE_cleanup-record"] = signedCleanupRecord({
      created: "true",
      cleanup: "true",
      "database-id": "db_123",
      "database-name": "shared-name",
      "api-url": "https://api.db9.ai",
    });

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

test("cleanupDatabase never falls back to a name for missing or invalid signed IDs", async () => {
  for (const databaseId of [undefined, null, "", "   ", 123, {}, [], true]) {
    await withGithubFiles(async () => {
      process.env["STATE_access-token"] = "anon-token";
      process.env["STATE_cleanup-record"] = signedCleanupRecord({
        created: "true",
        cleanup: "true",
        "database-id": databaseId,
        "database-name": "another-jobs-live-database",
        "api-url": "https://api.db9.ai",
      });
      const calls = [];
      await cleanupDatabase({ fetchImpl: mockFetch({}, calls) });
      assert.deepEqual(calls, []);
    });
  }
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
    };
    process.env["STATE_cleanup-record"] = signedCleanupRecord(values);

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
    };
    process.env["STATE_cleanup-record"] = signedCleanupRecord(values, "other-token");

    const calls = [];
    await cleanupDatabase({
      fetchImpl: mockFetch({}, calls),
    });

    assert.deepEqual(calls, []);
  });
});

test("cleanupDatabase refuses missing, legacy, malformed, or unknown records even with unsigned state", async () => {
  const values = {
    created: "true",
    cleanup: "true",
    "database-id": "db_123",
    "api-url": "https://api.db9.ai",
  };
  const payload = Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
  const legacy = `${payload}.${crypto.createHmac("sha256", "api-key").update(payload).digest("base64url")}`;
  const valid = signedCleanupRecord(values, "api-key");
  const records = ["", legacy, valid.replace(/^v2\./, "v3."), "v2.invalid", "v2..", signedCleanupRecord([], "api-key")];
  for (const record of records) {
    await withGithubFiles(async () => {
      process.env["INPUT_DB9-API-KEY"] = "api-key";
      process.env.STATE_created = "true";
      process.env.STATE_cleanup = "true";
      process.env["STATE_database-id"] = "db_123";
      process.env["STATE_api-url"] = "https://attacker.example.test";
      process.env["STATE_cleanup-record"] = record;
      const calls = [];

      await cleanupDatabase({ fetchImpl: mockFetch({}, calls) });

      assert.deepEqual(calls, [], `Unexpected request for record: ${record}`);
    });
  }
});

test("cleanupDatabase refuses a modified signed payload", async () => {
  await withGithubFiles(async () => {
    process.env["STATE_access-token"] = "anon-token";
    const original = signedCleanupRecord({
      created: "true", cleanup: "true", "database-id": "db_original", "api-url": "https://api.db9.ai",
    });
    const [version, payload, signature] = original.split(".");
    const values = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    values["database-id"] = "db_forged";
    const modified = Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
    process.env["STATE_cleanup-record"] = `${version}.${modified}.${signature}`;
    const calls = [];

    await cleanupDatabase({ fetchImpl: mockFetch({}, calls) });

    assert.deepEqual(calls, []);
  });
});

test("cleanupDatabase honors signed cleanup false despite conflicting individual state", async () => {
  await withGithubFiles(async () => {
    process.env["STATE_access-token"] = "anon-token";
    process.env.STATE_cleanup = "true";
    process.env["STATE_cleanup-record"] = signedCleanupRecord({
      created: "true", cleanup: "false", "database-id": "db_keep", "api-url": "https://api.db9.ai",
    });
    const calls = [];

    await cleanupDatabase({ fetchImpl: mockFetch({}, calls) });

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
