'use strict';

const { loadConfig, HELP } = require('./config');
const { FleetApi } = require('./api');
const { acquireStateLock, provision } = require('./provision');
const { supervise } = require('./supervisor');

async function main(argv = process.argv.slice(2)) {
    const config = loadConfig(argv);
    if (config.help) {
        console.log(HELP);
        return;
    }
    const controller = new AbortController();
    const shutdown = () => controller.abort();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    let unlock;
    try {
        unlock = acquireStateLock(config.stateDir);
        const api = new FleetApi(config, controller.signal);
        const credentials = await provision(config, api, controller.signal);
        console.log(
            `Prepared ${credentials.length} independent system probe credentials`,
        );
        if (config.command === 'run') {
            await supervise(config, credentials, api, controller.signal);
        }
    } catch (error) {
        if (!controller.signal.aborted) throw error;
    } finally {
        unlock?.();
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
    }
}

if (require.main === module) {
    main().catch((error) => {
        // Errors are sanitized at the API boundary; never print response bodies or config.
        console.error(`Fleet startup failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
