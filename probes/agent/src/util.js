'use strict';

/** Small helpers shared across modules (moved verbatim from the agent). */

function describeError(err) {
    if (err && err.cause && err.cause.code) {
        return `${err.cause.code}: ${err.cause.message || err.message}`;
    }
    return (err && err.message) || String(err);
}

function truncate(value, maxLength) {
    const text = String(value ?? '');
    return text.length <= maxLength
        ? text
        : `${text.slice(0, maxLength - 3)}...`;
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal && signal.aborted) {
            resolve();
            return;
        }

        const timer = setTimeout(() => {
            signal && signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        function onAbort() {
            clearTimeout(timer);
            resolve();
        }

        signal && signal.addEventListener('abort', onAbort, { once: true });
    });
}

module.exports = { describeError, truncate, sleep };
