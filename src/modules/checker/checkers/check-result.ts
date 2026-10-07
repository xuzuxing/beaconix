export interface SslCertificateInfo {
    expiresAt: Date;
    daysRemaining: number;
    issuer: string | null;
    subject: string | null;
}

/** Outcome of a single probe run (HTTP or TCP). */
export interface CheckResult {
    success: boolean;
    /** Round-trip time in milliseconds. */
    latency: number;
    error: string | null;
    checkedAt: Date;
    /** Present when SSL certificate monitoring was requested. */
    ssl?: SslCertificateInfo | null;
    /** Actual HTTP status code when the server responded (null otherwise). */
    statusCode?: number | null;
    /** Bounded snippet of the response body, for bodyContains rules. */
    bodyContains?: string | null;
}

/** A result reported by a remote probe. */
export interface ProbeReport {
    target: string;
    success: boolean;
    latency: number;
    error?: string | null;
    checkedAt?: Date;
    /** Actual HTTP status code the probe observed, when it has one. */
    statusCode?: number | null;
}

/** Normalizes fetch/socket failures into a short, human-readable message. */
export function describeCheckError(error: unknown): string {
    if (error instanceof Error) {
        // AbortSignal.timeout() rejects with a DOMException named TimeoutError.
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            return 'Request timed out';
        }
        return error.message;
    }

    return String(error);
}
