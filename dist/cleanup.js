"use strict";

const github = require("./github");
const { cleanupDatabase } = require("./db9-action");

cleanupDatabase().catch((error) => github.warning(`DB9 cleanup failed: ${error.message}`));
