"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const github = require("../dist/github");
const { cleanupDatabase, runMain } = require("../dist/db9-action");

const removedModeError = "Prefix-based cleanup mode has been removed. Use database or branch; post-step cleanup is still available.";

async function withEnvironment(callback) {
  const previous = { ...process.env };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "db9-prefix-removal-"));
  try {
    for (const name of Object.keys(process.env)) {
      if (/^(INPUT_|STATE_|GITHUB_)/.test(name)) {
        delete process.env[name];
      }
    }
    process.env.GITHUB_OUTPUT = path.join(directory, "output");
    process.env.GITHUB_ENV = path.join(directory, "env");
    process.env.GITHUB_STATE = path.join(directory, "state");
    process.env.TEST_PREFIX_REQUESTS = path.join(directory, "requests");
    return await callback(directory);
  } finally {
    process.env = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("removed cleanup mode and its post step make no API requests or state changes", async (context) => {
  context.mock.method(github, "setSecret", () => {});
  context.mock.method(github, "warning", () => {});
  for (const authenticated of [false, true]) {
    for (const project of ["", "shared-project"]) {
      for (const prefix of ["", "gha", "ci-", "ci--", "tmp_", "ci-/../", "ab!"]) {
        await withEnvironment(async (directory) => {
          process.env.INPUT_MODE = "cleanup";
          process.env["INPUT_DB9-API-KEY"] = authenticated ? "synthetic-api-key" : "";
          process.env["INPUT_PROJECT-ID"] = project;
          process.env["INPUT_CLEANUP-PREFIX"] = prefix;
          const calls = [];
          const exportedNames = ["DATABASE_URL", "DB9_DATABASE_URL", "DB9_DATABASE"];
          const exportedBefore = exportedNames.map((name) => process.env[name]);
          const fetchImpl = async (url, options) => {
            calls.push({ url, method: options.method });
            return new Response(JSON.stringify([
              { id: "db_other_repository", name: "gha-api-42", project_id: "shared-project" },
              { id: "db_live_production", name: "ci-prod", project_id: "shared-project" },
            ]));
          };
          await assert.rejects(() => runMain({ fetchImpl }), { message: removedModeError });
          await cleanupDatabase({ fetchImpl });
          assert.deepEqual(calls, []);
          for (const file of ["output", "env", "state"]) {
            assert.equal(fs.existsSync(path.join(directory, file)), false);
          }
          assert.deepEqual(exportedNames.map((name) => process.env[name]), exportedBefore);
        });
      }
    }
  }
});

test("main entry point fails for removed cleanup mode without requests or credential output", async () => {
  for (const mode of ["cleanup", "CLEANUP", " cleanup "]) {
    for (const authenticated of [false, true]) {
      await withEnvironment(async (directory) => {
        process.env.INPUT_MODE = mode;
        process.env["INPUT_DB9-API-KEY"] = authenticated ? "synthetic-api-key" : "";
        process.env["INPUT_PROJECT-ID"] = "shared-project";
        process.env["INPUT_CLEANUP-PREFIX"] = "ci--";
        const result = spawnSync(process.execPath, ["-e", `
          const fs = require("node:fs");
          require("./dist/github").setSecret = () => {};
          global.fetch = async () => {
            fs.appendFileSync(process.env.TEST_PREFIX_REQUESTS, "request");
            throw new Error("Unexpected API request");
          };
          require("./dist/index.js");
        `], { cwd: path.resolve(__dirname, ".."), env: process.env, encoding: "utf8", timeout: 10000 });
        assert.ifError(result.error);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.stdout.trim(), `::error::${removedModeError}`);
        assert.equal(result.stderr, "");
        assert.equal((result.stdout + result.stderr).includes("synthetic-api-key"), false);
        for (const file of ["requests", "output", "env", "state"]) {
          assert.equal(fs.existsSync(path.join(directory, file)), false);
        }
      });
    }
  }
});
