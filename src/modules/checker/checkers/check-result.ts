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
}

/** A result reported by a remote probe. */
export interface ProbeReport {
    target: string;
    success: boolean;
    latency: number;
    error?: string | null;
    checkedAt?: Date;
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
