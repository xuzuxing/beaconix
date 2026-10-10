'use strict';

/** Timestamped console logging, matching the original agent's format. */

function stamp() {
    return new Date().toISOString();
}

function log(...args) {
    console.log(`[${stamp()}]`, ...args);
}

function warn(...args) {
    console.warn(`[${stamp()}]`, ...args);
}

function error(...args) {
    console.error(`[${stamp()}]`, ...args);
}

module.exports = { log, warn, error };
