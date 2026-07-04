"use strict";

const fs = require("fs");
const os = require("os");

function envNameForInput(name) {
  return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}

function envNameForInputFallback(name) {
  return `INPUT_${name.replace(/[ -]/g, "_").toUpperCase()}`;
}

function getInput(name, options = {}) {
  const primary = envNameForInput(name);
  const fallback = envNameForInputFallback(name);
  const value = process.env[primary] ?? process.env[fallback] ?? "";
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

function escapeCommandValue(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function setOutput(name, value) {
  if (!appendFileCommand(process.env.GITHUB_OUTPUT, `${name}=${value}`)) {
    console.log(`::set-output name=${name}::${escapeCommandValue(value)}`);
  }
}

function exportVariable(name, value) {
  process.env[name] = String(value);
  appendFileCommand(process.env.GITHUB_ENV, `${name}=${value}`);
}

function addPath(path) {
  const value = String(path);
  process.env.PATH = `${value}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`;
  appendFileCommand(process.env.GITHUB_PATH, value);
}

function saveState(name, value) {
  if (!appendFileCommand(process.env.GITHUB_STATE, `${name}=${value}`)) {
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
  console.log(message);
}

function warning(message) {
  console.log(`::warning::${escapeCommandValue(message)}`);
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
  endGroup,
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
