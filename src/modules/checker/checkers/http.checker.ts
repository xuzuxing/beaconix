import { Injectable } from '@nestjs/common';
import { connect } from 'node:tls';
import { describeCheckError } from './check-result';
import type { CheckResult, SslCertificateInfo } from './check-result';

export interface HttpCheckOptions {
    checkSsl?: boolean;
    sslExpiryThreshold?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class HttpChecker {
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
        let url: URL;

        try {
            url = new URL(target);
        } catch {
            return this.failure(0, `Invalid URL "${target}"`);
        }

        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return this.failure(
                0,
                `Unsupported protocol "${url.protocol}" (expected http or https)`,
            );
        }

        const startedAt = Date.now();

        try {
            const response = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                signal: AbortSignal.timeout(timeout),
                headers: {
                    'user-agent': 'Beacon-Monitor/1.0',
                    accept: '*/*',
                },
            });

            const latency = Date.now() - startedAt;

            // Drain the body so the connection can be reused/closed cleanly.
            await response.arrayBuffer().catch(() => undefined);

            if (response.status !== expectedStatus) {
                return this.failure(
                    latency,
                    `Unexpected status ${response.status} (expected ${expectedStatus})`,
                );
            }

            if (options.checkSsl) {
                const ssl = await this.inspectSslCertificate(url, timeout);
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
                    };
                }

                return {
                    success: true,
                    latency,
                    error: null,
                    checkedAt: new Date(),
                    ssl,
                };
            }

            return {
                success: true,
                latency,
                error: null,
                checkedAt: new Date(),
            };
        } catch (error) {
            return this.failure(
                Date.now() - startedAt,
                describeCheckError(error),
            );
        }
    }

    private failure(latency: number, error: string): CheckResult {
        return { success: false, latency, error, checkedAt: new Date() };
    }

    private inspectSslCertificate(
        url: URL,
        timeout: number,
    ): Promise<SslCertificateInfo> {
        if (url.protocol !== 'https:') {
            return Promise.reject(
                new Error('SSL monitoring requires an https:// target'),
            );
        }

        return new Promise<SslCertificateInfo>((resolve, reject) => {
            const socket = connect({
                host: url.hostname,
                port: Number(url.port) || 443,
                servername: url.hostname,
                rejectUnauthorized: false,
                timeout,
            });

            let settled = false;

            const finish = (error: Error | null, info?: SslCertificateInfo) => {
                if (settled) return;
                settled = true;
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
            return `SSL certificate expired on ${ssl.expiresAt.toISOString()}`;
        }

        if (ssl.daysRemaining <= expiryThresholdDays) {
            return `SSL certificate expires in ${ssl.daysRemaining} day(s) on ${ssl.expiresAt.toISOString()}`;
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
