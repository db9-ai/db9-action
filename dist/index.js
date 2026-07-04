"use strict";

const github = require("./github");
const { runMain } = require("./db9-action");

try {
  runMain();
} catch (error) {
  github.setFailed(error);
}
