"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const github = require("./github");

function sanitizeDatabaseName(value, fallback = "gha-db9") {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const name = cleaned || fallback;
  return name.slice(0, 63).replace(/-$/g, "") || fallback;
}

function generateDatabaseName(env = process.env) {
  const repo = env.GITHUB_REPOSITORY ? env.GITHUB_REPOSITORY.split("/").pop() : "repo";
  const run = env.GITHUB_RUN_ID || Date.now().toString();
  const attempt = env.GITHUB_RUN_ATTEMPT || "1";
  const base = `gha-${repo}-${run}-${attempt}`;
  const sanitized = sanitizeDatabaseName(base);
  if (sanitized.length >= 12) {
    return sanitized;
  }
  return sanitizeDatabaseName(`${sanitized}-${crypto.randomBytes(3).toString("hex")}`);
}

function parseDatabaseUrlFromEnv(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^DATABASE_URL=(.+)$/);
    if (match) {
      return match[1].trim();
    }
  }
  throw new Error("Could not find DATABASE_URL in db9 connect output");
}

function parseJsonObject(stdout, label) {
  const text = String(stdout || "").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`Could not parse ${label} JSON: ${error.message}`);
  }
}

function readInputs() {
  const apiKey = github.getInput("db9-api-key", { trimWhitespace: false });
  if (apiKey) {
    github.setSecret(apiKey);
  }
  return {
    apiKey,
    apiUrl: github.getInput("db9-api-url"),
    cleanup: github.getBooleanInput("cleanup", true),
    databaseName: github.getInput("database-name"),
    databaseUser: github.getInput("database-user") || "admin",
    exportEnv: github.getBooleanInput("export-env", true),
    installCli: github.getBooleanInput("install-cli", true),
    installUrl: github.getInput("install-url") || "https://db9.ai/install",
    isolateCredentials: github.getBooleanInput("isolate-credentials", true),
    projectId: github.getInput("project-id"),
    region: github.getInput("region"),
  };
}

function commandExists(command, env = process.env) {
  const checker = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = spawnSync(checker, args, {
    encoding: "utf8",
    env,
    shell: process.platform !== "win32",
  });
  return result.status === 0;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    env: options.env || process.env,
    shell: options.shell || false,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.status !== 0) {
    const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}${detail ? `:\n${detail}` : ""}`);
  }
  return { stdout, stderr };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureDb9Cli(inputs, runtime) {
  if (!inputs.installCli) {
    if (!commandExists("db9")) {
      throw new Error("db9 CLI was not found on PATH and install-cli is false");
    }
    return "";
  }

  ensureDir(runtime.installDir);
  github.startGroup("Install DB9 CLI");
  try {
    runCommand(
      "sh",
      ["-c", 'curl -fsSL "$DB9_INSTALL_URL" | sh'],
      {
        env: {
          ...process.env,
          DB9_INSTALL_DIR: runtime.installDir,
          DB9_INSTALL_URL: inputs.installUrl,
        },
      },
    );
    github.addPath(runtime.installDir);
    return path.join(runtime.installDir, process.platform === "win32" ? "db9.exe" : "db9");
  } finally {
    github.endGroup();
  }
}

function buildRuntime(inputs) {
  const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
  const root = fs.mkdtempSync(path.join(runnerTemp, "db9-action-"));
  const home = inputs.isolateCredentials ? path.join(root, "home") : (process.env.HOME || os.homedir());
  const installDir = path.join(root, "bin");
  ensureDir(home);
  return { home, installDir, root };
}

function buildDb9Env(inputs, runtime) {
  const env = {
    ...process.env,
    HOME: runtime.home,
  };
  if (inputs.apiKey) {
    env.DB9_API_KEY = inputs.apiKey;
  }
  if (inputs.apiUrl) {
    env.DB9_API_URL = inputs.apiUrl;
  }
  if (runtime.installDir) {
    env.PATH = `${runtime.installDir}${path.delimiter}${env.PATH || ""}`;
  }
  return env;
}

function createDatabase(inputs, runtime) {
  const name = inputs.databaseName ? sanitizeDatabaseName(inputs.databaseName) : generateDatabaseName();
  const args = ["--json", "create", "--name", name];
  if (inputs.region) {
    args.push("--region", inputs.region);
  }
  if (inputs.projectId) {
    args.push("--project", inputs.projectId);
  }

  github.startGroup("Create DB9 database");
  try {
    const result = runCommand("db9", args, { env: buildDb9Env(inputs, runtime) });
    const data = parseJsonObject(result.stdout, "db9 create");
    return {
      id: typeof data.id === "string" ? data.id : "",
      name: typeof data.name === "string" && data.name ? data.name : name,
    };
  } finally {
    github.endGroup();
  }
}

function connectDatabase(inputs, runtime, database) {
  const target = database.id || database.name;
  const args = ["db", "connect", target, "--env"];
  if (inputs.databaseUser) {
    args.push("--user", inputs.databaseUser);
  }
  github.startGroup("Fetch DB9 connection URL");
  try {
    const result = runCommand("db9", args, { env: buildDb9Env(inputs, runtime) });
    const databaseUrl = parseDatabaseUrlFromEnv(result.stdout);
    github.setSecret(databaseUrl);
    return databaseUrl;
  } finally {
    github.endGroup();
  }
}

function writeOutputs(inputs, database, databaseUrl) {
  github.setOutput("database-url", databaseUrl);
  github.setOutput("database-name", database.name);
  github.setOutput("database-id", database.id);
  github.setOutput("database-user", inputs.databaseUser);

  if (inputs.exportEnv) {
    github.exportVariable("DATABASE_URL", databaseUrl);
    github.exportVariable("DB9_DATABASE_URL", databaseUrl);
    github.exportVariable("DB9_DATABASE", database.name);
  }
}

function saveCleanupState(inputs, runtime, database) {
  github.saveState("created", "true");
  github.saveState("cleanup", String(inputs.cleanup));
  github.saveState("database-name", database.name);
  github.saveState("database-id", database.id);
  github.saveState("database-user", inputs.databaseUser);
  github.saveState("db9-home", runtime.home);
  github.saveState("install-dir", runtime.installDir);
  github.saveState("api-url", inputs.apiUrl);
}

function cleanupDatabase() {
  const cleanup = github.getState("cleanup");
  const created = github.getState("created");
  if (created !== "true" || cleanup !== "true") {
    github.info("DB9 cleanup skipped.");
    return;
  }

  const apiKey = github.getInput("db9-api-key", { trimWhitespace: false });
  if (apiKey) {
    github.setSecret(apiKey);
  }
  const runtime = {
    home: github.getState("db9-home") || process.env.HOME || os.homedir(),
    installDir: github.getState("install-dir"),
  };
  const inputs = {
    apiKey,
    apiUrl: github.getState("api-url") || github.getInput("db9-api-url"),
  };
  const target = github.getState("database-id") || github.getState("database-name");
  if (!target) {
    github.warning("DB9 cleanup skipped because no database name or ID was recorded.");
    return;
  }

  github.startGroup("Delete DB9 database");
  try {
    runCommand("db9", ["delete", target, "--yes"], { env: buildDb9Env(inputs, runtime) });
    github.info(`Deleted DB9 database ${target}.`);
  } catch (error) {
    github.warning(`DB9 cleanup failed: ${error.message}`);
  } finally {
    github.endGroup();
  }
}

function runMain() {
  const inputs = readInputs();
  const runtime = buildRuntime(inputs);
  ensureDb9Cli(inputs, runtime);
  const database = createDatabase(inputs, runtime);
  saveCleanupState(inputs, runtime, database);
  const databaseUrl = connectDatabase(inputs, runtime, database);
  writeOutputs(inputs, database, databaseUrl);
  github.info(`Created DB9 database ${database.name}.`);
}

module.exports = {
  buildDb9Env,
  buildRuntime,
  cleanupDatabase,
  connectDatabase,
  createDatabase,
  generateDatabaseName,
  parseDatabaseUrlFromEnv,
  parseJsonObject,
  readInputs,
  runMain,
  sanitizeDatabaseName,
};
