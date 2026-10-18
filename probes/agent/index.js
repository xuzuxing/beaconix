'use strict';

/**
 * Tencent SCF root entry point (console handler: `index.main`).
 *
 * The implementation lives in functions/scf.js and is required through the same
 * relative path in the repository and inside the deployed zip, where this file
 * sits at the archive root next to functions/ and src/.
 */
const { main_handler: runOnce } = require('./functions/scf');

exports.main = async (event, context) => runOnce(event, context);
