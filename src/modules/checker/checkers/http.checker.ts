import { Injectable } from '@nestjs/common';
import { toIsoString } from '../../../common/utils/date.util';
import { connect } from 'node:tls';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { describeCheckError } from './check-result';
import type {
    CheckMetadata,
    CheckResult,
    HttpAssertionFailure,
    SslCertificateInfo,
} from './check-result';
import type { MonitorModel } from '../../../generated/prisma/models';
import { MonitorType } from '../../../generated/prisma/enums';
import type { CheckerStrategy } from './checker.interface';
import { validateHttpMonitorConfig } from '../../monitors/http-monitor-config';
import { evaluateHttpAssertions } from './http-assertions';
import { sanitizeMonitoringDiagnostic } from '../../../common/authorization/monitoring-projection';
import { pinnedLookup, resolvePublicHost } from './network-guard';
import type { PinnedAddress } from './network-guard';

export interface HttpCheckOptions {
    checkSsl?: boolean;
    sslExpiryThreshold?: number;
    /** Validated again here for direct callers and persisted configurations. */
    config?: unknown;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many leading characters of the response body to keep for rules. */
const BODY_SNIPPET_LENGTH = 512;
const BODY_BYTE_LIMIT = 2048;
/** Redirect hops the guarded fetcher follows before giving up. */
const MAX_REDIRECT_HOPS = 5;

function isRedirectStatus(status: number): boolean {
    return (
        status === 301 ||
        status === 302 ||
        status === 303 ||
        status === 307 ||
        status === 308
    );
}
const ASSERTION_ERRORS: Record<HttpAssertionFailure, string> = {
    KEYWORD: 'HTTP keyword assertion failed',
    JSON_VALUE: 'HTTP JSON field assertion failed',
    INVALID_JSON: 'HTTP response is not valid JSON',
    BODY_LIMIT: 'HTTP response exceeds the configured body limit',
    INVALID_ENCODING: 'HTTP response is not valid UTF-8',
};

class HttpResponseBodyError extends Error {
    constructor(
        readonly reason: 'BODY_LIMIT' | 'INVALID_ENCODING',
        readonly bytes: number,
        readonly limit: number,
    ) {
        super(ASSERTION_ERRORS[reason]);
    }
}

@Injectable()
export class HttpChecker implements CheckerStrategy {
    readonly type = MonitorType.HTTP;

    run(monitor: MonitorModel): Promise<CheckResult> {
        return this.check(
            monitor.target,
            monitor.timeout,
            monitor.expectedStatus,
            {
                checkSsl: monitor.checkSsl,
                sslExpiryThreshold: monitor.sslExpiryThreshold,
                config: monitor.config,
            },
        );
    }
    /**
     * GETs `target` and compares the response status with `expectedStatus`.
     * Any transport-level failure (DNS, connect, TLS, timeout) is a failure.
     */
    async check(
        target: string,
        timeout: number,
        expectedStatus: number,
        options: HttpCheckOptions = {},
    ): Promise<CheckResult> {
        let config: ReturnType<typeof validateHttpMonitorConfig>;
        try {
            config = validateHttpMonitorConfig(options.config);
        } catch {
            return {
                ...this.failure(0, 'Invalid HTTP monitor configuration'),
                evaluated: false,
                failureKind: 'CONFIGURATION',
            };
        }
        const requiresBody =
            config.keyword !== undefined || !!config.jsonAssertions;
        let url: URL;

        try {
            url = new URL(target);
        } catch {
            return this.failure(0, 'Invalid URL');
        }

        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return this.failure(
                0,
                `Unsupported protocol "${url.protocol}" (expected http or https)`,
            );
        }
        if (url.username || url.password) {
            return {
                ...this.failure(
                    0,
                    'HTTP target must not contain URL credentials',
                ),
                evaluated: false,
                failureKind: 'CONFIGURATION',
            };
        }

        const startedAt = Date.now();
        let observedStatus: number | null = null;
        let headerLatency: number | null = null;
        let bodyContains: string | null = null;
        let meta: Extract<CheckMetadata, { protocol: 'HTTP' }> | undefined;
        const controller = new AbortController();
        const dispatchers: Agent[] = [];
        const ensureDeadline = () => {
            if (
                controller.signal.aborted ||
                Date.now() - startedAt >= timeout
            ) {
                throw new DOMException('Request timed out', 'TimeoutError');
            }
        };
        const timer = setTimeout(
            () =>
                controller.abort(
                    new DOMException('Request timed out', 'TimeoutError'),
                ),
            timeout,
        );

        try {
            // Redirection is followed hop by hop so every hop is vetted: a
            // public host answering 302 into the internal network must not turn
            // the platform into an internal scanner.
            const guarded = await this.fetchGuarded(
                url,
                controller.signal,
                ensureDeadline,
                dispatchers,
            );

            if ('rejection' in guarded) {
                return {
                    ...this.failure(0, guarded.rejection),
                    evaluated: false,
                    failureKind: 'CONFIGURATION',
                };
            }

            const response = guarded.response;

            headerLatency = Date.now() - startedAt;
            const latency = headerLatency;
            observedStatus = response.status;
            meta = {
                protocol: 'HTTP',
                bodyTruncated: true,
                ...(requiresBody
                    ? { bodyLimitBytes: config.maxBodyBytes }
                    : {}),
            };
            const body = await this.readBody(
                response,
                controller.signal,
                requiresBody ? config.maxBodyBytes : undefined,
            );
            bodyContains = body.snippet;
            meta.bodyTruncated = body.truncated;
            if (requiresBody) meta.bodyBytes = body.bytes;

            if (response.status !== expectedStatus) {
                return {
                    ...this.failure(
                        latency,
                        `Unexpected status ${response.status} (expected ${expectedStatus})`,
                        response.status,
                        bodyContains,
                    ),
                    failureKind: 'ASSERTION',
                    meta,
                };
            }

            ensureDeadline();
            let ssl: SslCertificateInfo | undefined;
            if (options.checkSsl) {
                try {
                    const remaining = timeout - (Date.now() - startedAt);
                    ssl = await this.inspectSslCertificate(
                        url,
                        remaining,
                        guarded.initialAddress,
                    );
                    ensureDeadline();
                } catch (error) {
                    return {
                        ...this.failure(
                            Date.now() - startedAt,
                            describeCheckError(error),
                            response.status,
                            bodyContains,
                        ),
                        serviceVerdict: 'SUCCESS',
                        sslVerdict: 'NO_EVIDENCE',
                        failureKind:
                            controller.signal.aborted ||
                            (error as Error).name === 'TimeoutError'
                                ? 'TIMEOUT'
                                : 'TRANSPORT',
                        meta,
                    };
                }
                const sslFailure = this.evaluateSsl(
                    ssl,
                    options.sslExpiryThreshold ?? 30,
                );

                if (sslFailure) {
                    return {
                        success: false,
                        latency,
                        error: sslFailure,
                        checkedAt: new Date(),
                        ssl,
                        serviceVerdict: 'SUCCESS',
                        sslVerdict:
                            ssl.daysRemaining < 0 ? 'EXPIRED' : 'EXPIRING',
                        statusCode: response.status,
                        bodyContains,
                        failureKind: 'ASSERTION',
                        meta,
                    };
                }
            }

            if (requiresBody) {
                const assertion = evaluateHttpAssertions(body.text, config);
                ensureDeadline();
                meta.assertions = assertion.results;
                if (assertion.failure) {
                    meta.assertionFailure = assertion.failure;
                    return {
                        success: false,
                        latency,
                        error: ASSERTION_ERRORS[assertion.failure],
                        checkedAt: new Date(),
                        statusCode: response.status,
                        bodyContains,
                        ...(ssl ? { ssl } : {}),
                        ...(ssl ? { sslVerdict: 'VALID' as const } : {}),
                        failureKind: 'ASSERTION',
                        meta,
                    };
                }
            }
            return {
                success: true,
                latency,
                error: null,
                checkedAt: new Date(),
                statusCode: response.status,
                bodyContains,
                ...(ssl ? { ssl } : {}),
                serviceVerdict: 'SUCCESS',
                ...(ssl ? { sslVerdict: 'VALID' as const } : {}),
                meta,
            };
        } catch (error) {
            const code =
                (error as { cause?: { code?: string }; code?: string }).cause
                    ?.code ?? (error as { code?: string }).code;
            if (
                options.checkSsl &&
                code &&
                /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS_CERT/.test(code)
            ) {
                return {
                    ...this.failure(
                        Date.now() - startedAt,
                        describeCheckError(error),
                    ),
                    serviceVerdict: 'NO_EVIDENCE',
                    sslVerdict: 'INVALID',
                    failureReason: 'SSL_INVALID',
                    failureKind: 'TRANSPORT',
                    meta,
                };
            }
            const latency = headerLatency ?? Date.now() - startedAt;
            if (error instanceof HttpResponseBodyError) {
                meta = {
                    protocol: 'HTTP',
                    bodyTruncated: true,
                    bodyBytes: error.bytes,
                    bodyLimitBytes: error.limit,
                };
            }
            if (observedStatus !== null && observedStatus !== expectedStatus) {
                return {
                    ...this.failure(
                        latency,
                        `Unexpected status ${observedStatus} (expected ${expectedStatus})`,
                        observedStatus,
                        bodyContains,
                    ),
                    failureKind: 'ASSERTION',
                    meta,
                };
            }
            if (error instanceof HttpResponseBodyError) {
                return {
                    ...this.failure(latency, error.message, observedStatus),
                    failureKind: 'ASSERTION',
                    meta: { ...meta!, assertionFailure: error.reason },
                };
            }
            return {
                ...this.failure(
                    latency,
                    describeCheckError(error),
                    observedStatus,
                    bodyContains,
                ),
                failureKind:
                    controller.signal.aborted ||
                    (error as Error).name === 'TimeoutError'
                        ? 'TIMEOUT'
                        : 'TRANSPORT',
                meta,
            };
        } finally {
            clearTimeout(timer);
            controller.abort();
            await Promise.all(
                dispatchers.map((dispatcher) =>
                    dispatcher.destroy().catch(() => {}),
                ),
            );
        }
    }

    /**
     * Fetches `target`, refusing to connect to (or be redirected into) private
     * and reserved addresses. Returns a rejection instead of a response when a
     * hop is not allowed, so the caller can classify it as a configuration
     * failure rather than a transport error.
     */
    private async fetchGuarded(
        target: URL,
        signal: AbortSignal,
        ensureDeadline: () => void,
        dispatchers: Agent[],
    ): Promise<
        | { response: Response; initialAddress: PinnedAddress }
        | { rejection: string }
    > {
        let current = target;
        let initialAddress: PinnedAddress | undefined;

        for (let hop = 0; ; hop += 1) {
            const verdict = await resolvePublicHost(current.hostname, signal);

            if (!verdict.ok) {
                return {
                    rejection: `Target "${current.hostname}" is not a public address (${verdict.reason})`,
                };
            }

            ensureDeadline();
            initialAddress ??= verdict;
            // The URL stays intact for Host, SNI and certificate validation;
            // only socket DNS lookup is replaced with the checked address.
            const dispatcher = new Agent({
                connect: { lookup: pinnedLookup(verdict) },
            });
            dispatchers.push(dispatcher);

            const requestOptions = {
                method: 'GET',
                redirect: 'manual' as const,
                signal,
                dispatcher,
                headers: {
                    'user-agent': 'Beaconix-Monitor/1.0',
                    accept: '*/*',
                },
            };
            const response = await fetch(current, requestOptions);

            const location = isRedirectStatus(response.status)
                ? response.headers.get('location')
                : null;

            if (!location) return { response, initialAddress };
            // Discard redirect bodies before opening the next connection.
            await response.body?.cancel();

            if (hop >= MAX_REDIRECT_HOPS) {
                return {
                    rejection: `Too many redirects (more than ${MAX_REDIRECT_HOPS})`,
                };
            }

            let next: URL;

            try {
                next = new URL(location, current);
            } catch {
                return { rejection: `Invalid redirect location "${location}"` };
            }

            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                return {
                    rejection: `Redirect to unsupported protocol "${next.protocol}"`,
                };
            }
            if (next.username || next.password) {
                return {
                    rejection: 'Redirect URL must not contain credentials',
                };
            }

            current = next;
        }
    }

    private failure(
        latency: number,
        error: string,
        statusCode: number | null = null,
        bodyContains: string | null = null,
    ): CheckResult {
        return {
            success: false,
            latency,
            error: sanitizeMonitoringDiagnostic(error),
            checkedAt: new Date(),
            statusCode,
            bodyContains,
            serviceVerdict: 'FAILURE',
            failureReason:
                statusCode !== null
                    ? 'STATUS_MISMATCH'
                    : /timed out|timeout/i.test(error)
                      ? 'TIMEOUT'
                      : /ECONNREFUSED/i.test(error)
                        ? 'CONNECTION_REFUSED'
                        : 'CHECK_FAILED',
        };
    }

    /** Legacy rules keep their prefix; assertions require a complete, bounded body. */
    private async readBody(
        response: Response,
        signal: AbortSignal,
        maxBodyBytes?: number,
    ): Promise<{
        snippet: string | null;
        text: string;
        truncated: boolean;
        bytes: number;
    }> {
        if (!response.body)
            return { snippet: null, text: '', truncated: false, bytes: 0 };
        const complete = maxBodyBytes !== undefined;
        const limit = maxBodyBytes ?? BODY_BYTE_LIMIT;
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: complete });
        const snippetDecoder = new TextDecoder();
        let bytes = 0;
        let text = '';
        let snippetBytes = 0;
        let snippetText = '';
        let snippetFinished = false;
        let truncated = false;
        let abort: () => void = () => {};
        const aborted = new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason as Error);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        });
        const decode = (chunk?: Uint8Array) => {
            try {
                return decoder.decode(chunk, { stream: chunk !== undefined });
            } catch {
                throw new HttpResponseBodyError(
                    'INVALID_ENCODING',
                    bytes,
                    limit,
                );
            }
        };
        // Freeze the legacy prefix at exactly the same chunk/byte/character boundary,
        // even when the independent assertion reader continues consuming the body.
        const collectSnippet = (value: Uint8Array) => {
            if (snippetFinished) return;
            const chunk = value.subarray(0, BODY_BYTE_LIMIT - snippetBytes);
            snippetBytes += chunk.byteLength;
            snippetText += snippetDecoder.decode(chunk, { stream: true });
            if (
                chunk.byteLength < value.byteLength ||
                snippetBytes >= BODY_BYTE_LIMIT ||
                snippetText.length >= BODY_SNIPPET_LENGTH
            ) {
                snippetText += snippetDecoder.decode();
                snippetFinished = true;
            }
        };
        try {
            while (true) {
                const { done, value } = await Promise.race([
                    reader.read(),
                    aborted,
                ]);
                if (done) break;
                const remaining = limit - bytes;
                if (complete && value.byteLength > remaining) {
                    throw new HttpResponseBodyError(
                        'BODY_LIMIT',
                        bytes + value.byteLength,
                        limit,
                    );
                }
                const chunk = value.subarray(0, remaining);
                bytes += chunk.byteLength;
                text += decode(chunk);
                collectSnippet(chunk);
                if (!complete && snippetFinished) {
                    truncated = true;
                    break;
                }
            }
            text += decode();
            if (!snippetFinished) snippetText += snippetDecoder.decode();
            const trimmed = snippetText.trim().slice(0, BODY_SNIPPET_LENGTH);
            return { snippet: trimmed || null, text, truncated, bytes };
        } finally {
            signal.removeEventListener('abort', abort);
            void reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }

    private inspectSslCertificate(
        url: URL,
        timeout: number,
        address: PinnedAddress,
    ): Promise<SslCertificateInfo> {
        if (url.protocol !== 'https:') {
            return Promise.reject(
                new Error('SSL monitoring requires an https:// target'),
            );
        }

        return new Promise<SslCertificateInfo>((resolve, reject) => {
            const socket = connect({
                host: address.address,
                port: Number(url.port) || 443,
                servername: isIP(url.hostname.replace(/^\[|\]$/g, ''))
                    ? undefined
                    : url.hostname,
                rejectUnauthorized: false,
                timeout,
            });

            let settled = false;
            const timer = setTimeout(
                () =>
                    finish(
                        new DOMException('Request timed out', 'TimeoutError'),
                    ),
                timeout,
            );

            const finish = (error: Error | null, info?: SslCertificateInfo) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.destroy();

                if (error) {
                    reject(error);
                    return;
                }

                resolve(info!);
            };

            socket.once('secureConnect', () => {
                const certificate = socket.getPeerCertificate();

                if (!certificate || !certificate.valid_to) {
                    finish(new Error('No SSL certificate was presented'));
                    return;
                }

                const expiresAt = new Date(certificate.valid_to);

                if (Number.isNaN(expiresAt.getTime())) {
                    finish(new Error('SSL certificate expiry is invalid'));
                    return;
                }

                finish(null, {
                    expiresAt,
                    daysRemaining: Math.ceil(
                        (expiresAt.getTime() - Date.now()) / DAY_MS,
                    ),
                    issuer: this.formatCertificateName(certificate.issuer),
                    subject: this.formatCertificateName(certificate.subject),
                });
            });
            socket.once('timeout', () =>
                finish(
                    new Error(
                        `SSL certificate check timed out after ${timeout}ms`,
                    ),
                ),
            );
            socket.once('error', (error: Error) => finish(error));
        });
    }

    private evaluateSsl(
        ssl: SslCertificateInfo,
        expiryThresholdDays: number,
    ): string | null {
        if (ssl.daysRemaining < 0) {
            return `SSL certificate expired on ${toIsoString(ssl.expiresAt)}`;
        }

        if (ssl.daysRemaining <= expiryThresholdDays) {
            return `SSL certificate expires in ${ssl.daysRemaining} day(s) on ${toIsoString(ssl.expiresAt)}`;
        }

        return null;
    }

    private formatCertificateName(
        name: Record<string, string | string[] | undefined> | undefined,
    ): string | null {
        if (!name) return null;

        if (typeof name.CN === 'string') return name.CN;
        if (Array.isArray(name.CN)) return name.CN.join(', ');

        const formatted = Object.entries(name)
            .filter(([, value]) => value)
            .map(
                ([key, value]) =>
                    `${key}=${Array.isArray(value) ? value.join(', ') : value}`,
            )
            .join(', ');

        return formatted || null;
    }
}
