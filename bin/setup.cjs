#!/usr/bin/env node
'use strict';
const path = require('node:path');
const fileUrl = require('node:url').pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'huaweicloud-core', 'src', 'setup-cli.mjs'),
).href;
import(fileUrl).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
