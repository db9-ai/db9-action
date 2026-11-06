"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");

function envNameForInput(name) {
  return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}

function getInput(name, options = {}) {
  const value = process.env[envNameForInput(name)] ?? "";
  const trimmed = options.trimWhitespace === false ? value : value.trim();
  if (options.required && !trimmed) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return trimmed;
}

function getBooleanInput(name, defaultValue) {
  const raw = getInput(name);
  if (!raw) {
    return defaultValue;
  }
  switch (raw.toLowerCase()) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      throw new Error(`Input ${name} must be true or false, got: ${raw}`);
  }
}

function appendFileCommand(file, value) {
  if (!file) {
    return false;
  }
  fs.appendFileSync(file, `${value}${os.EOL}`, { encoding: "utf8" });
  return true;
}

function keyValueFileCommand(name, value) {
  const text = String(value);
  if (!/[\r\n]/.test(text)) {
    return `${name}=${text}`;
  }

  let delimiter;
  do {
    delimiter = `ghadelimiter_${crypto.randomUUID()}`;
  } while (String(name).includes(delimiter) || text.includes(delimiter));
  return `${name}<<${delimiter}${os.EOL}${text}${os.EOL}${delimiter}`;
}

function escapeCommandValue(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function setOutput(name, value) {
  if (!appendFileCommand(process.env.GITHUB_OUTPUT, keyValueFileCommand(name, value))) {
    console.log(`::set-output name=${name}::${escapeCommandValue(value)}`);
  }
}

function exportVariable(name, value) {
  process.env[name] = String(value);
  appendFileCommand(process.env.GITHUB_ENV, keyValueFileCommand(name, value));
}

function addPath(path) {
  const value = String(path);
  if (/[\r\n]/.test(value)) {
    throw new Error("PATH entries must not contain newline characters");
  }
  process.env.PATH = `${value}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`;
  appendFileCommand(process.env.GITHUB_PATH, value);
}

function saveState(name, value) {
  if (!appendFileCommand(process.env.GITHUB_STATE, keyValueFileCommand(name, value))) {
    console.log(`::save-state name=${name}::${escapeCommandValue(value)}`);
  }
}

function getState(name) {
  return process.env[`STATE_${name}`] || "";
}

function setSecret(value) {
  if (value) {
    console.log(`::add-mask::${escapeCommandValue(value)}`);
  }
}

function info(message) {
  const text = String(message);
  let marker;
  do {
    marker = crypto.randomUUID();
  } while (text.includes(marker));
  // Keep both runner command syntaxes inert without changing masked values.
  console.log(`::stop-commands::${marker}`);
  try {
    console.log(text);
  } finally {
    console.log(`::${marker}::`);
  }
}

function warning(message) {
  console.log(`::warning::${escapeCommandValue(message)}`);
}

function error(message) {
  console.log(`::error::${escapeCommandValue(message)}`);
}

function appendSummary(message) {
  try {
    return appendFileCommand(process.env.GITHUB_STEP_SUMMARY, message);
  } catch (_error) {
    return false;
  }
}

function setFailed(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`::error::${escapeCommandValue(message)}`);
  process.exitCode = 1;
}

function startGroup(name) {
  console.log(`::group::${escapeCommandValue(name)}`);
}

function endGroup() {
  console.log("::endgroup::");
}

module.exports = {
  addPath,
  appendSummary,
  endGroup,
  error,
  exportVariable,
  getBooleanInput,
  getInput,
  getState,
  info,
  saveState,
  setFailed,
  setOutput,
  setSecret,
  startGroup,
  warning,
};
