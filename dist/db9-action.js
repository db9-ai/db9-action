"use strict";

const crypto = require("crypto");

const github = require("./github");

const DEFAULT_API_URL = "https://api.db9.ai";
const ACTION_VERSION = "1";
const TERMINAL_FAILURE_STATES = new Set(["CREATE_FAILED", "FAILED", "DISABLED"]);

class Db9ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "Db9ApiError";
    this.status = status;
    this.body = body;
  }
}

function sanitizeDatabaseName(value, fallback = "gha-db9") {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const name = cleaned || fallback;
  return name.slice(0, 63).replace(/-$/g, "") || fallback;
}

function sanitizeDatabasePrefix(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/g, "")
    .slice(0, 63);
}

function sanitizeMode(value) {
  const mode = String(value || "database").trim().toLowerCase();
  if (["database", "branch", "cleanup"].includes(mode)) {
    return mode;
  }
  throw new Error(`Input mode must be database, branch, or cleanup; got: ${value}`);
}

function parsePositiveInteger(value, fallback, inputName) {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Input ${inputName} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function generateDatabaseName(env = process.env, options = {}) {
  const prefix = sanitizeDatabaseName(options.prefix || "gha", "gha");
  const repo = env.GITHUB_REPOSITORY ? env.GITHUB_REPOSITORY.split("/").pop() : "repo";
  const run = env.GITHUB_RUN_ID || Date.now().toString();
  const attempt = env.GITHUB_RUN_ATTEMPT || "1";
  const worker = options.workerId ? `-${sanitizeDatabaseName(options.workerId, "worker")}` : "";
  const base = `${prefix}-${repo}-${run}-${attempt}${worker}`;
  const sanitized = sanitizeDatabaseName(base);
  if (sanitized.length >= 12) {
    return sanitized;
  }
  return sanitizeDatabaseName(`${sanitized}-${crypto.randomBytes(3).toString("hex")}`);
}

function encodeUriComponentStrict(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildTemporaryConnectionString(info) {
  for (const key of ["user", "token", "host"]) {
    if (!info[key] || typeof info[key] !== "string") {
      throw new Error(`Invalid DB9 connect-token response: missing ${key}`);
    }
  }
  const port = Number(info.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid DB9 connect-token response: missing or invalid port");
  }
  const database = typeof info.database === "string" && info.database ? info.database : "postgres";
  return `postgresql://${encodeUriComponentStrict(info.user)}:${encodeUriComponentStrict(info.token)}@${info.host}:${port}/${encodeUriComponentStrict(database)}`;
}

function readInputs() {
  const apiKey = github.getInput("db9-api-key", { trimWhitespace: false });
  if (apiKey) {
    github.setSecret(apiKey);
  }
  return {
    apiKey,
    apiUrl: normalizeApiUrl(github.getInput("db9-api-url")),
    cleanup: github.getBooleanInput("cleanup", true),
    cleanupPrefix: github.getInput("cleanup-prefix"),
    databaseName: github.getInput("database-name"),
    databaseNamePrefix: github.getInput("database-name-prefix") || "gha",
    databaseUser: github.getInput("database-user") || "admin",
    exportEnv: github.getBooleanInput("export-env", true),
    mode: sanitizeMode(github.getInput("mode") || "database"),
    projectId: github.getInput("project-id"),
    region: github.getInput("region"),
    snapshotAt: github.getInput("snapshot-at"),
    sourceDatabaseId: github.getInput("source-database-id"),
    sourceDatabaseName: github.getInput("source-database-name"),
    wait: github.getBooleanInput("wait", true),
    waitIntervalSeconds: parsePositiveInteger(github.getInput("wait-interval-seconds"), 2, "wait-interval-seconds"),
    waitTimeoutSeconds: parsePositiveInteger(github.getInput("wait-timeout-seconds"), 120, "wait-timeout-seconds"),
    workerId: github.getInput("worker-id"),
  };
}

function normalizeApiUrl(value) {
  const candidate = String(value || "").trim() || DEFAULT_API_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_error) {
    throw new Error(`DB9 API URL must be an https URL, got: ${candidate}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`DB9 API URL must use https, got: ${parsed.protocol.replace(":", "")}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("DB9 API URL must not include credentials");
  }
  if (parsed.hash) {
    throw new Error("DB9 API URL must not include a fragment");
  }
  return candidate.replace(/\/+$/g, "");
}

function apiUrl(baseUrl, requestPath) {
  return `${normalizeApiUrl(baseUrl)}/${requestPath.replace(/^\/+/g, "")}`;
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { message: text };
  }
}

async function requestJson(method, baseUrl, requestPath, options = {}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": `db9-action/${ACTION_VERSION}`,
    "X-DB9-Action": "db9-action",
    "X-DB9-Action-Version": ACTION_VERSION,
    ...(options.headers || {}),
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await (options.fetchImpl || fetch)(apiUrl(baseUrl, requestPath), {
    method,
    headers,
    redirect: "error",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await readResponseBody(response);
  if (!response.ok) {
    const detail = body.message || body.error || body.detail || response.statusText;
    throw new Db9ApiError(`DB9 API ${method} ${requestPath} failed (${response.status}): ${detail}`, response.status, body);
  }
  return body;
}

async function getAccess(inputs, options = {}) {
  if (inputs.apiKey) {
    return { token: inputs.apiKey, anonymous: null };
  }

  github.startGroup("Register anonymous DB9 account");
  try {
    const body = await requestJson("POST", inputs.apiUrl, "/customer/anonymous-register", {
      body: {},
      fetchImpl: options.fetchImpl,
    });
    if (!body.token || typeof body.token !== "string") {
      throw new Error("DB9 anonymous-register response is missing token");
    }
    github.setSecret(body.token);
    if (body.anonymous_secret) {
      github.setSecret(body.anonymous_secret);
    }
    return {
      token: body.token,
      anonymous: {
        id: typeof body.anonymous_id === "string" ? body.anonymous_id : "",
        secret: typeof body.anonymous_secret === "string" ? body.anonymous_secret : "",
      },
    };
  } finally {
    github.endGroup();
  }
}

async function refreshAnonymousAccess(inputs, anonymous, options = {}) {
  if (!anonymous || !anonymous.id || !anonymous.secret) {
    return "";
  }
  const body = await requestJson("POST", inputs.apiUrl, "/customer/anonymous-refresh", {
    body: {
      anonymous_id: anonymous.id,
      anonymous_secret: anonymous.secret,
    },
    fetchImpl: options.fetchImpl,
  });
  if (!body.token || typeof body.token !== "string") {
    throw new Error("DB9 anonymous-refresh response is missing token");
  }
  github.setSecret(body.token);
  return body.token;
}

async function createDatabase(inputs, access, options = {}) {
  const name = inputs.databaseName
    ? sanitizeDatabaseName(inputs.databaseName)
    : generateDatabaseName(process.env, {
        prefix: inputs.databaseNamePrefix,
        workerId: inputs.workerId,
      });
  const body = { name };
  if (inputs.region) {
    body.region = inputs.region;
  }
  if (inputs.projectId) {
    body.project_id = inputs.projectId;
  }

  github.startGroup("Create DB9 database");
  try {
    const data = await requestJson("POST", inputs.apiUrl, "/customer/databases", {
      token: access.token,
      body,
      fetchImpl: options.fetchImpl,
    });
    return {
      id: typeof data.id === "string" ? data.id : "",
      name: typeof data.name === "string" && data.name ? data.name : name,
      state: typeof data.state === "string" ? data.state : "",
    };
  } finally {
    github.endGroup();
  }
}

async function listDatabases(inputs, access, options = {}) {
  const path = inputs.projectId
    ? `/customer/databases?all=true&project_id=${encodeURIComponent(inputs.projectId)}`
    : "/customer/databases?all=true";
  const data = await requestJson("GET", inputs.apiUrl, path, {
    token: access.token,
    fetchImpl: options.fetchImpl,
  });
  if (Array.isArray(data)) {
    return data;
  }
  if (data && Array.isArray(data.databases)) {
    return data.databases;
  }
  throw new Error("DB9 databases list response is not an array");
}

async function resolveSourceDatabase(inputs, access, options = {}) {
  if (!inputs.projectId) {
    throw new Error("branch mode requires project-id");
  }
  if (!inputs.sourceDatabaseId && !inputs.sourceDatabaseName) {
    throw new Error("branch mode requires source-database-id or source-database-name");
  }
  const databases = await listDatabases(inputs, access, options);
  const match = databases.find((database) =>
    database &&
    database.project_id === inputs.projectId &&
    (inputs.sourceDatabaseId
      ? database.id === inputs.sourceDatabaseId
      : database.name === inputs.sourceDatabaseName),
  );
  if (!match || typeof match.id !== "string" || !match.id) {
    throw new Error("Could not find DB9 source database in the specified project");
  }
  return match.id;
}

async function createBranch(inputs, access, options = {}) {
  const sourceDatabaseId = await resolveSourceDatabase(inputs, access, options);
  const name = inputs.databaseName
    ? sanitizeDatabaseName(inputs.databaseName)
    : generateDatabaseName(process.env, {
        prefix: inputs.databaseNamePrefix,
        workerId: inputs.workerId,
      });
  const body = { name };
  if (inputs.snapshotAt) {
    body.snapshot_at = inputs.snapshotAt;
  }

  github.startGroup("Create DB9 branch");
  try {
    const data = await requestJson("POST", inputs.apiUrl, `/customer/databases/${encodeURIComponent(sourceDatabaseId)}/branch`, {
      token: access.token,
      body,
      fetchImpl: options.fetchImpl,
    });
    return {
      id: typeof data.id === "string" ? data.id : "",
      name: typeof data.name === "string" && data.name ? data.name : name,
      state: typeof data.state === "string" ? data.state : "",
      parentDatabaseId: typeof data.parent_database_id === "string" ? data.parent_database_id : sourceDatabaseId,
      snapshotAt: typeof data.snapshot_at === "string" ? data.snapshot_at : inputs.snapshotAt,
    };
  } finally {
    github.endGroup();
  }
}

async function getDatabase(inputs, access, database, options = {}) {
  const target = database.id || database.name;
  if (!target) {
    throw new Error("Cannot fetch DB9 database status without database ID or name");
  }
  const data = await requestJson("GET", inputs.apiUrl, `/customer/databases/${encodeURIComponent(target)}`, {
    token: access.token,
    fetchImpl: options.fetchImpl,
  });
  return {
    ...database,
    id: typeof data.id === "string" ? data.id : database.id,
    name: typeof data.name === "string" && data.name ? data.name : database.name,
    state: typeof data.state === "string" ? data.state : database.state,
    stateReason: typeof data.state_reason === "string" ? data.state_reason : "",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseActive(inputs, access, database, options = {}) {
  if (!inputs.wait) {
    return database;
  }

  const deadline = Date.now() + inputs.waitTimeoutSeconds * 1000;
  let current = database;
  github.startGroup("Wait for DB9 database");
  try {
    while (true) {
      if (current.state === "ACTIVE") {
        return current;
      }
      if (TERMINAL_FAILURE_STATES.has(current.state)) {
        const reason = current.stateReason ? `: ${current.stateReason}` : "";
        throw new Error(`DB9 database ${current.name || current.id} reached ${current.state}${reason}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for DB9 database ${current.name || current.id} to become ACTIVE`);
      }
      await sleep((options.pollIntervalMs || inputs.waitIntervalSeconds * 1000));
      current = await getDatabase(inputs, access, current, options);
    }
  } finally {
    github.endGroup();
  }
}

async function connectDatabase(inputs, access, database, options = {}) {
  const target = database.id || database.name;
  const body = {};
  if (inputs.databaseUser) {
    body.role = inputs.databaseUser;
  }

  github.startGroup("Fetch DB9 connection URL");
  try {
    const data = await requestJson("POST", inputs.apiUrl, `/customer/databases/${encodeURIComponent(target)}/connect-token`, {
      token: access.token,
      body,
      fetchImpl: options.fetchImpl,
    });
    const databaseUrl = buildTemporaryConnectionString(data);
    github.setSecret(databaseUrl);
    return {
      databaseUrl,
      user: typeof data.user === "string" ? data.user : inputs.databaseUser,
      expiresAt: typeof data.expires_at === "string" ? data.expires_at : "",
      expiresInSeconds: Number.isInteger(data.expires_in_seconds) ? data.expires_in_seconds : "",
    };
  } finally {
    github.endGroup();
  }
}

function writeOutputs(inputs, database, connection) {
  github.setOutput("database-url", connection.databaseUrl);
  github.setOutput("database-name", database.name);
  github.setOutput("database-id", database.id);
  github.setOutput("database-user", connection.user);
  github.setOutput("expires-at", connection.expiresAt);
  github.setOutput("database-state", database.state || "");

  if (inputs.exportEnv) {
    github.exportVariable("DATABASE_URL", connection.databaseUrl);
    github.exportVariable("DB9_DATABASE_URL", connection.databaseUrl);
    github.exportVariable("DB9_DATABASE", database.name);
  }
}

async function cleanupByPrefix(inputs, access, options = {}) {
  if (!inputs.projectId) {
    throw new Error("cleanup mode requires project-id");
  }
  const prefix = inputs.cleanupPrefix;
  const sanitizedPrefix = sanitizeDatabasePrefix(prefix);
  if (!sanitizedPrefix || sanitizedPrefix.length < 3) {
    throw new Error("cleanup mode requires cleanup-prefix with at least 3 safe characters");
  }
  if (!inputs.apiKey) {
    throw new Error("cleanup mode requires db9-api-key");
  }

  github.startGroup("Delete stale DB9 databases");
  try {
    const databases = await listDatabases(inputs, access, options);
    const targets = databases.filter((database) =>
      database &&
      database.project_id === inputs.projectId &&
      typeof database.name === "string" &&
      database.name.startsWith(sanitizedPrefix),
    );
    if (targets.some((database) => typeof database.id !== "string" || !database.id)) {
      throw new Error("DB9 cleanup target is missing a database ID");
    }
    for (const database of targets) {
      await deleteDatabase(inputs, access.token, database.id, options);
      github.info(`Deleted DB9 database ${database.name}.`);
    }
    github.setOutput("cleanup-count", String(targets.length));
    return targets.length;
  } finally {
    github.endGroup();
  }
}

function saveCleanupState(inputs, access, database) {
  const values = {
    created: "true",
    cleanup: String(inputs.cleanup),
    "database-name": database.name,
    "database-id": database.id,
    "api-url": inputs.apiUrl,
    "access-token": access.token,
  };
  if (access.anonymous) {
    values["anonymous-id"] = access.anonymous.id;
    values["anonymous-secret"] = access.anonymous.secret;
  }
  for (const [name, value] of Object.entries(values)) {
    github.saveState(name, value);
  }
  const payload = Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", access.token).update(payload).digest("base64url");
  github.saveState("cleanup-record", `${payload}.${signature}`);
}

function readCleanupRecord(accessToken) {
  const record = github.getState("cleanup-record");
  if (!record) {
    return null;
  }
  const separator = record.lastIndexOf(".");
  if (separator < 1 || separator === record.length - 1) {
    throw new Error("DB9 cleanup record is malformed");
  }
  const payload = record.slice(0, separator);
  const signature = record.slice(separator + 1);
  const expected = crypto.createHmac("sha256", accessToken).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("DB9 cleanup record failed integrity verification");
  }
  let values;
  try {
    values = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (_error) {
    throw new Error("DB9 cleanup record is malformed");
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("DB9 cleanup record is malformed");
  }
  return values;
}

function readCleanupState(record, name, fallback = "") {
  if (record) {
    return record[name] === undefined || record[name] === null ? "" : String(record[name]);
  }
  return github.getState(name) || fallback;
}

async function deleteDatabase(inputs, token, target, options = {}) {
  return requestJson("DELETE", inputs.apiUrl, `/customer/databases/${encodeURIComponent(target)}`, {
    token,
    fetchImpl: options.fetchImpl,
  });
}

async function cleanupDatabase(options = {}) {
  const apiKey = github.getInput("db9-api-key", { trimWhitespace: false });
  if (apiKey) {
    github.setSecret(apiKey);
  }
  const legacyToken = apiKey || github.getState("access-token");
  let record = null;
  try {
    record = legacyToken ? readCleanupRecord(legacyToken) : null;
  } catch (error) {
    github.warning(`DB9 cleanup skipped: ${error.message}`);
    return;
  }
  const created = readCleanupState(record, "created");
  const cleanup = readCleanupState(record, "cleanup");
  if (created !== "true" || cleanup !== "true") {
    github.info("DB9 cleanup skipped.");
    return;
  }
  const inputs = {
    apiKey,
    apiUrl: normalizeApiUrl(readCleanupState(record, "api-url") || github.getInput("db9-api-url")),
  };
  const target = readCleanupState(record, "database-id") || readCleanupState(record, "database-name");
  if (!target) {
    github.warning("DB9 cleanup skipped because no database name or ID was recorded.");
    return;
  }

  let token = apiKey || readCleanupState(record, "access-token");
  if (token) {
    github.setSecret(token);
  } else {
    token = await refreshAnonymousAccess(
      inputs,
      {
        id: readCleanupState(record, "anonymous-id"),
        secret: readCleanupState(record, "anonymous-secret"),
      },
      options,
    );
  }

  github.startGroup("Delete DB9 database");
  try {
    await deleteDatabase(inputs, token, target, options);
    github.info(`Deleted DB9 database ${target}.`);
  } catch (error) {
    const anonymous = {
      id: readCleanupState(record, "anonymous-id"),
      secret: readCleanupState(record, "anonymous-secret"),
    };
    if (!apiKey && error.status === 401 && anonymous.id && anonymous.secret) {
      try {
        github.warning("DB9 cleanup token expired; refreshing anonymous token and retrying.");
        const refreshedToken = await refreshAnonymousAccess(inputs, anonymous, options);
        await deleteDatabase(inputs, refreshedToken, target, options);
        github.info(`Deleted DB9 database ${target}.`);
        return;
      } catch (retryError) {
        github.warning(`DB9 cleanup retry failed: ${retryError.message}`);
        return;
      }
    }
    github.warning(`DB9 cleanup failed: ${error.message}`);
  } finally {
    github.endGroup();
  }
}

async function runMain(options = {}) {
  const inputs = readInputs();
  if (inputs.mode === "branch" && !inputs.projectId) {
    throw new Error("branch mode requires project-id");
  }
  if (inputs.mode === "cleanup" && !inputs.projectId) {
    throw new Error("cleanup mode requires project-id");
  }
  if (inputs.mode === "cleanup" && !inputs.apiKey) {
    throw new Error("cleanup mode requires db9-api-key");
  }
  const access = await getAccess(inputs, options);
  if (inputs.mode === "cleanup") {
    const count = await cleanupByPrefix(inputs, access, options);
    github.info(`Deleted ${count} DB9 database(s).`);
    return;
  }

  const created = inputs.mode === "branch" ? await createBranch(inputs, access, options) : await createDatabase(inputs, access, options);
  const shouldWait = inputs.mode === "branch" || (created.state && created.state !== "ACTIVE");
  const database = shouldWait ? await waitForDatabaseActive(inputs, access, created, options) : created;
  saveCleanupState(inputs, access, database);
  const connection = await connectDatabase(inputs, access, database, options);
  writeOutputs(inputs, database, connection);
  github.info(`Created DB9 ${inputs.mode} ${database.name}.`);
}

module.exports = {
  apiUrl,
  buildTemporaryConnectionString,
  cleanupDatabase,
  connectDatabase,
  cleanupByPrefix,
  createDatabase,
  createBranch,
  deleteDatabase,
  Db9ApiError,
  encodeUriComponentStrict,
  generateDatabaseName,
  getAccess,
  getDatabase,
  listDatabases,
  readInputs,
  requestJson,
  resolveSourceDatabase,
  runMain,
  sanitizeDatabaseName,
  sanitizeDatabasePrefix,
  normalizeApiUrl,
  sanitizeMode,
  waitForDatabaseActive,
};
