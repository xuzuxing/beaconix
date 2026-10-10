'use strict';

const {
    PROBE_SECRET_HEADER,
    MAX_ERROR_MESSAGE_LENGTH,
} = require('./constants');
const { describeError, truncate } = require('./util');

/**
 * POST/GET JSON against the Beacon API, unwrapping the
 * `{ data, meta }` envelope added by TransformInterceptor.
 *
 * `token` is the probe secret; pass an empty value for public enrollment
 * endpoints, which must not carry the `x-probe-secret` header.
 */
async function requestJson({
    apiUrl,
    token,
    path: requestPath,
    method = 'POST',
    body,
    timeoutMs,
}) {
    const headers = {
        accept: 'application/json',
    };

    if (token) {
        headers[PROBE_SECRET_HEADER] = token;
    }
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(`${apiUrl}${requestPath}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        throw new Error(
            `Request ${method} ${requestPath} failed: ${describeError(err)}`,
        );
    } finally {
        clearTimeout(timer);
    }

    const text = await response.text();
    let parsed = null;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = text;
        }
    }

    if (!response.ok) {
        throw new Error(
            `${method} ${requestPath} failed with HTTP ${response.status}: ${truncate(text, MAX_ERROR_MESSAGE_LENGTH)}`,
        );
    }

    if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        return parsed.data;
    }

    return parsed;
}

async function heartbeat(config) {
    return requestJson({
        apiUrl: config.apiUrl,
        token: config.token,
        path: '/probes/heartbeat',
        method: 'POST',
        // Lets the backend derive the offline threshold from this probe's own
        // cadence instead of a fixed window the probe might never meet.
        body: { intervalSeconds: config.intervalSeconds },
        timeoutMs: config.timeoutMs,
    });
}

async function reportResults(config, results) {
    const chunkSize = config.maxResultsPerReport;
    for (let i = 0; i < results.length; i += chunkSize) {
        const chunk = results.slice(i, i + chunkSize);
        await requestJson({
            apiUrl: config.apiUrl,
            token: config.token,
            path: '/probes/results',
            method: 'POST',
            body: { results: chunk },
            timeoutMs: config.timeoutMs,
        });
    }
}

async function pullValidation(config) {
    return requestJson({
        apiUrl: config.apiUrl,
        token: config.token,
        path: '/probes/validation/pull',
        method: 'POST',
        timeoutMs: config.timeoutMs,
    });
}

async function answerValidation(config, validationId, answer) {
    return requestJson({
        apiUrl: config.apiUrl,
        token: config.token,
        path: `/probes/validation/${encodeURIComponent(validationId)}/answer`,
        method: 'POST',
        body: { answer },
        timeoutMs: config.timeoutMs,
    });
}

async function revokeProbe(config) {
    return requestJson({
        apiUrl: config.apiUrl,
        token: config.token,
        path: '/probes/revoke',
        method: 'POST',
        timeoutMs: config.timeoutMs,
    });
}

module.exports = {
    requestJson,
    heartbeat,
    reportResults,
    pullValidation,
    answerValidation,
    revokeProbe,
};
