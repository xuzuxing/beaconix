export interface SslCertificateInfo {
    expiresAt: Date;
    daysRemaining: number;
    issuer: string | null;
    subject: string | null;
}

export type CheckFailureKind =
    | 'TRANSPORT'
    | 'ASSERTION'
    | 'TIMEOUT'
    | 'CONFIGURATION'
    | 'CAPABILITY'
    | 'POLICY';

export type HttpAssertionFailure =
    | 'KEYWORD'
    | 'JSON_VALUE'
    | 'INVALID_JSON'
    | 'BODY_LIMIT'
    | 'INVALID_ENCODING';
export type HttpAssertionResult =
    | { kind: 'keyword'; passed: boolean }
    | { kind: 'json'; index: number; passed: boolean };

export type CheckMetadata =
    | {
          protocol: 'MYSQL' | 'POSTGRESQL' | 'REDIS' | 'MONGODB';
          operation: 'SELECT 1' | 'PING';
      }
    | {
          protocol: 'DOCKER';
          containerState: string;
          health: string | null;
          startedAt: string | null;
      }
    | { protocol: 'GRPC'; serving: boolean }
    | { protocol: 'WEBSOCKET'; heartbeat: boolean }
    | {
          protocol: 'DNS';
          recordType: 'A' | 'AAAA' | 'CNAME';
          actualValues: string[];
          ttl?: number[];
      }
    | { protocol: 'PING'; sent: number; received: number; packetLoss: number }
    | {
          protocol: 'HTTP';
          bodyTruncated: boolean;
          bodyBytes?: number;
          bodyLimitBytes?: number;
          assertions?: HttpAssertionResult[];
          assertionFailure?: HttpAssertionFailure;
      };

/** Outcome of a single local check. */
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
    /** False means execution was blocked, not that the target is DOWN. */
    evaluated?: boolean;
    failureKind?: CheckFailureKind | null;
    meta?: CheckMetadata;
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
