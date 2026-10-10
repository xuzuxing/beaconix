'use strict';

const pkg = require('../package.json');

/** Single source of truth for the CLI version (also used by self-update). */
const VERSION = pkg.version;

module.exports = { VERSION };
