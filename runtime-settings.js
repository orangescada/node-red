"use strict";

const path = require("path");

const userDir = path.join(__dirname, "data");

module.exports = {
  userDir,
  flowFile: "flows.json",
  flowFilePretty: true,
  nodesDir: path.join(__dirname, "nodes"),
};
