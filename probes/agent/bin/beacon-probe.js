#!/usr/bin/env node
'use strict';

/**
 * Beacon probe agent CLI entry point.
 *
 * All logic lives under ../src; this file only wires argv to the dispatcher so
 * it stays a thin, package-manager-friendly `bin`.
 */

const { main } = require('../src/cli');
const logger = require('../src/logger');

void main(process.argv.slice(2)).catch((err) => {
    logger.error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
});
