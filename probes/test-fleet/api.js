'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

class ApiError extends Error {
    constructor(status, route) {
        super(`${route} returned HTTP ${status}`);
        this.status = status;
    }
}

class FleetApi {
    constructor(config, signal, log = console.log, wait = sleep) {
        this.config = config;
        this.signal = signal;
        this.log = log;
        this.wait = wait;
        this.accessToken = '';
        this.refreshToken = '';
    }

    async raw(
        route,
        { method = 'GET', body, token, secret, signal = this.signal } = {},
    ) {
        const requestSignal = AbortSignal.any([this.signal, signal]);
        for (let attempt = 0; ; attempt += 1) {
            requestSignal.throwIfAborted();
            let response;
            let text;
            try {
                response = await fetch(`${this.config.apiUrl}${route}`, {
                    method,
                    redirect: 'error',
                    signal: AbortSignal.any([
                        requestSignal,
                        AbortSignal.timeout(this.config.apiTimeoutMs),
                    ]),
                    headers: {
                        accept: 'application/json',
                        ...(body !== undefined
                            ? { 'content-type': 'application/json' }
                            : {}),
                        ...(token ? { authorization: `Bearer ${token}` } : {}),
                        ...(secret ? { 'x-probe-secret': secret } : {}),
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                });
                text = await response.text();
            } catch {
                requestSignal.throwIfAborted();
                // A POST may have committed before the connection failed.
                // Never blindly retry creates or print response bodies/secrets.
                throw new Error(
                    `${route} request failed or timed out; no automatic retry`,
                );
            }
            if (response.status === 429 && attempt < this.config.rateRetries) {
                const header = response.headers.get('retry-after');
                const seconds = header ? Number(header) : NaN;
                const delayMs = Number.isFinite(seconds)
                    ? seconds * 1000
                    : header
                      ? Date.parse(header) - Date.now()
                      : 60000;
                const delay = Number.isFinite(delayMs)
                    ? Math.max(1000, delayMs)
                    : 60000;
                this.log(
                    `Rate limited on ${route}; waiting ${Math.ceil(delay / 1000)}s`,
                );
                await this.wait(delay, undefined, { signal: requestSignal });
                continue;
            }
            if (!response.ok) throw new ApiError(response.status, route);
            if (!text) return null;
            let json;
            try {
                json = JSON.parse(text);
            } catch {
                throw new Error(`${route} returned invalid JSON`);
            }
            return json && typeof json === 'object' && 'data' in json
                ? json.data
                : json;
        }
    }

    acceptSession(data) {
        if (data?.twoFactorRequired) {
            throw new Error(
                'This account requires MFA; password-only fleet login is not supported',
            );
        }
        if (data?.user?.globalRole !== 'SUPER_ADMIN') {
            throw new Error(
                'Fleet provisioning requires a SUPER_ADMIN account',
            );
        }
        if (
            typeof data.accessToken !== 'string' ||
            !data.accessToken ||
            typeof data.refreshToken !== 'string' ||
            !data.refreshToken
        ) {
            throw new Error('Login did not return a valid token pair');
        }
        this.accessToken = data.accessToken;
        this.refreshToken = data.refreshToken;
    }

    async login() {
        this.acceptSession(
            await this.raw('/auth/login', {
                method: 'POST',
                body: {
                    email: this.config.email,
                    password: this.config.password,
                },
            }),
        );
    }

    async request(route, options = {}) {
        try {
            return await this.raw(route, {
                ...options,
                token: this.accessToken,
            });
        } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 401)
                throw error;
            this.acceptSession(
                await this.raw('/auth/refresh', {
                    method: 'POST',
                    body: { refreshToken: this.refreshToken },
                    signal: options.signal,
                }),
            );
            return this.raw(route, { ...options, token: this.accessToken });
        }
    }
}

module.exports = { FleetApi, ApiError };
