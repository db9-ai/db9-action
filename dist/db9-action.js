"use strict";

const crypto = require("crypto");

const github = require("./github");

const DEFAULT_API_URL = "https://api.db9.ai";
const ACTION_VERSION = "1";

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
    apiUrl: github.getInput("db9-api-url") || DEFAULT_API_URL,
    cleanup: github.getBooleanInput("cleanup", true),
    databaseName: github.getInput("database-name"),
    databaseUser: github.getInput("database-user") || "admin",
    exportEnv: github.getBooleanInput("export-env", true),
    projectId: github.getInput("project-id"),
    region: github.getInput("region"),
  };
}

function apiUrl(baseUrl, requestPath) {
  return `${baseUrl.replace(/\/+$/g, "")}/${requestPath.replace(/^\/+/g, "")}`;
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
  const name = inputs.databaseName ? sanitizeDatabaseName(inputs.databaseName) : generateDatabaseName();
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
    };
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

  if (inputs.exportEnv) {
    github.exportVariable("DATABASE_URL", connection.databaseUrl);
    github.exportVariable("DB9_DATABASE_URL", connection.databaseUrl);
    github.exportVariable("DB9_DATABASE", database.name);
  }
}

function saveCleanupState(inputs, access, database) {
  github.saveState("created", "true");
  github.saveState("cleanup", String(inputs.cleanup));
  github.saveState("database-name", database.name);
  github.saveState("database-id", database.id);
  github.saveState("api-url", inputs.apiUrl);
  github.saveState("access-token", access.token);
  if (access.anonymous) {
    github.saveState("anonymous-id", access.anonymous.id);
    github.saveState("anonymous-secret", access.anonymous.secret);
  }
}

async function deleteDatabase(inputs, token, target, options = {}) {
  return requestJson("DELETE", inputs.apiUrl, `/customer/databases/${encodeURIComponent(target)}`, {
    token,
    fetchImpl: options.fetchImpl,
  });
}

async function cleanupDatabase(options = {}) {
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
  const inputs = {
    apiKey,
    apiUrl: github.getState("api-url") || github.getInput("db9-api-url") || DEFAULT_API_URL,
  };
  const target = github.getState("database-id") || github.getState("database-name");
  if (!target) {
    github.warning("DB9 cleanup skipped because no database name or ID was recorded.");
    return;
  }

  let token = apiKey || github.getState("access-token");
  if (token) {
    github.setSecret(token);
  } else {
    token = await refreshAnonymousAccess(
      inputs,
      {
        id: github.getState("anonymous-id"),
        secret: github.getState("anonymous-secret"),
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
      id: github.getState("anonymous-id"),
      secret: github.getState("anonymous-secret"),
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
  const access = await getAccess(inputs, options);
  const database = await createDatabase(inputs, access, options);
  saveCleanupState(inputs, access, database);
  const connection = await connectDatabase(inputs, access, database, options);
  writeOutputs(inputs, database, connection);
  github.info(`Created DB9 database ${database.name}.`);
}

module.exports = {
  apiUrl,
  buildTemporaryConnectionString,
  cleanupDatabase,
  connectDatabase,
  createDatabase,
  deleteDatabase,
  Db9ApiError,
  encodeUriComponentStrict,
  generateDatabaseName,
  getAccess,
  readInputs,
  requestJson,
  runMain,
  sanitizeDatabaseName,
};
