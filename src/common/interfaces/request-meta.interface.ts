/** Request metadata carried into auth flows (challenge creation, audit). */
export interface RequestMeta {
    ipAddress: string | null;
    userAgent: string | null;
}
