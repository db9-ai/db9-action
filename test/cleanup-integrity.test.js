"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const eventCode = "DB9_CLEANUP_INTEGRITY_FAILURE";
const fixtureToken = "fixture-token";
const fixtureSecret = "fixture-secret";
const untrustedValue = "unverified%value\r\n::error::injected-event";
const fixtureValues = {
  created: "true",
  cleanup: "true",
  "database-id": untrustedValue,
  "database-name": untrustedValue,
  "api-url": "https://unverified.example.test",
};

function signedRecord(values, token = fixtureToken, secret = "") {
  const payload = Buffer.from(JSON.stringify(values)).toString("base64url");
  const signature = crypto.createHmac("sha256", token).update(payload).update("\0").update(secret).digest("base64url");
  return `v2.${payload}.${signature}`;
}

function runPost({ record, anonymous = false, credentials = true, summary = "present", exitCode } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "db9-integrity-test-"));
  const summaryPath = path.join(directory, "summary");
  const requestPath = path.join(directory, "requests");
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(INPUT_|STATE_|GITHUB_)/.test(name)) {
      delete env[name];
    }
  }
  if (credentials) {
    if (anonymous) {
      env["STATE_access-token"] = fixtureToken;
      env["STATE_anonymous-secret"] = fixtureSecret;
    } else {
      env["INPUT_DB9-API-KEY"] = fixtureToken;
    }
  }
  env["STATE_cleanup-record"] = record || "";
  env.TEST_REQUEST_FILE = requestPath;
  env.TEST_EXIT_CODE = exitCode === undefined ? "" : String(exitCode);
  if (summary === "present") {
    fs.writeFileSync(summaryPath, "Existing summary\n");
    env.GITHUB_STEP_SUMMARY = summaryPath;
  } else if (summary === "unwritable") {
    env.GITHUB_STEP_SUMMARY = directory;
  }
  try {
    const result = spawnSync(process.execPath, ["-e", `
      const fs = require("node:fs");
      global.fetch = async () => {
        fs.appendFileSync(process.env.TEST_REQUEST_FILE, "request\\n");
        throw new Error("Unexpected API request");
      };
      if (process.env.TEST_EXIT_CODE) {
        process.exitCode = Number(process.env.TEST_EXIT_CODE);
      }
      require(process.argv[1]);
    `, path.resolve(__dirname, "../dist/cleanup.js")], { env, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    return {
      ...result,
      summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : "",
      requests: fs.existsSync(requestPath) ? fs.readFileSync(requestPath, "utf8") : "",
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("post emits a fixed integrity event and best-effort summary without trusting state", () => {
  for (const anonymous of [false, true]) {
    const valid = signedRecord(fixtureValues, fixtureToken, anonymous ? fixtureSecret : "");
    const [version, payload, signature] = valid.split(".");
    const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const changedPayload = Buffer.from(JSON.stringify({ ...fixtureValues, "database-id": "changed" })).toString("base64url");
    const records = [
      `${version}.${payload}.${changedSignature}`,
      `${valid}longer`,
      `${version}.${changedPayload}.${signature}`,
    ];
    for (const record of records) {
      for (const summary of ["present", "missing", "unwritable"]) {
        const result = runPost({ record, anonymous, summary });
        assert.equal(result.status, 0);
        assert.equal(result.stderr, "");
        assert.equal(result.requests, "");
        const alerts = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("::error::"));
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0], `::error::${eventCode}: Cleanup record signature verification failed; cleanup skipped without making API requests.`);
        assert.doesNotMatch(result.stdout, /::warning::/);
        if (summary === "present") {
          assert.ok(result.summary.startsWith("Existing summary\n"));
          assert.match(result.summary, new RegExp(eventCode));
        } else {
          assert.equal(result.summary, "");
        }
        for (const forbidden of [fixtureToken, fixtureSecret, untrustedValue, payload, signature, record, "unverified.example.test"]) {
          assert.ok(!alerts[0].includes(forbidden));
          assert.ok(!result.summary.includes(forbidden));
        }
      }
    }
  }
});

test("post integrity alerts preserve an existing nonzero exit code even when summary cannot be written", () => {
  for (const summary of ["present", "missing", "unwritable"]) {
    const result = runPost({ record: signedRecord(fixtureValues, "different-token"), summary, exitCode: 7 });
    assert.equal(result.status, 7);
    assert.match(result.stdout, new RegExp(`::error::${eventCode}`));
    assert.equal(result.requests, "");
  }
});

test("post benign skips retain their existing messages without integrity alerts or summary writes", () => {
  const cases = [
    { credentials: false, record: signedRecord(fixtureValues), message: "credentials are missing" },
    { record: "", message: "record is missing" },
    { record: "v1.legacy", message: "unsupported version" },
    { record: "v2.invalid", message: "record is malformed" },
    { record: "v2..", message: "record is malformed" },
    { record: signedRecord([]), message: "record is malformed" },
    { record: signedRecord({ ...fixtureValues, created: "false" }), message: "DB9 cleanup skipped." },
    { record: signedRecord({ ...fixtureValues, cleanup: "false" }), message: "DB9 cleanup skipped." },
    { record: signedRecord({ ...fixtureValues, "database-id": "" }), message: "no valid database ID" },
  ];
  for (const entry of cases) {
    const result = runPost(entry);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes(entry.message));
    assert.doesNotMatch(result.stdout, /::error::|DB9_CLEANUP_INTEGRITY_FAILURE/);
    assert.equal(result.summary, "Existing summary\n");
    assert.equal(result.requests, "");
  }
});
