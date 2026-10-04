import { Injectable } from '@nestjs/common';
import { describeCheckError } from './check-result';
import type { CheckResult } from './check-result';

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
}
