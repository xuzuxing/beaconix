import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JwtConfig } from '../../config';
import { SettingsService } from '../settings';

/** Fallback lifetime of a signed object link, in seconds. */
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Even a deliberately short OSS signature TTL is too short for a ticket form:
 * the file is uploaded first and previewed until the ticket is submitted, so a
 * five-minute link would be dead before the user is done typing.
 */
const MIN_TTL_SECONDS = 30 * 60;

const MAX_TTL_SECONDS = 24 * 60 * 60;

/** Path the signed links point at — the endpoint reads `exp` + `sig` back. */
export const PUBLIC_OBJECT_PATH = '/api/attachments/object';

/**
 * Signs storage object keys so a browser can open them directly.
 *
 * Everything behind `/api/attachments/object` used to require a Bearer token,
 * which `<img src>` / `<a href>` can never send. A ticket attachment therefore
 * ships as a pre-signed link: the API only hands it out to callers that may see
 * the attachment (see `AttachmentsService` permission checks), and the link
 * itself expires. The key never becomes a bearer of authority on its own.
 */
@Injectable()
export class AttachmentObjectUrlService {
    private readonly secret: string;

    constructor(
        configService: ConfigService,
        private readonly settings: SettingsService,
    ) {
        this.secret = configService.get<JwtConfig>('jwt')!.secret;
    }

    private async publicUrl(key: string): Promise<string> {
        const base = (
            await this.settings.getString('storage.publicBaseUrl', '')
        ).replace(/\/$/, '');
        return base ? `${base}/${key}` : '';
    }

    /**
     * Direct link for a stored object.
     *
     * Only a remote provider is trusted to own a public URL (OSS / CDN). A LOCAL
     * object lives on this server's disk, while `storage.publicBaseUrl` often
     * points at a host or path that does not map to that directory — following
     * it is what turned ticket images into 404s — so LOCAL always goes through
     * the signed endpoint.
     */
    async toObjectUrl(
        key: string,
        provider: string,
        storedUrl?: string | null,
    ): Promise<string> {
        if (provider === 'OSS' && storedUrl) return storedUrl;
        return this.sign(key);
    }

    async sign(key: string): Promise<string> {
        const exp = Math.floor(Date.now() / 1000) + (await this.ttlSeconds());
        const sig = this.digest(key, exp);
        // Add the public base prefix.
        return await this.publicUrl(
            `${PUBLIC_OBJECT_PATH}?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`,
        );
    }

    /** True when `sig` was issued for exactly this key and has not expired. */
    verify(key: string, exp: number, sig: string): boolean {
        if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
        const expected = this.digest(key, exp);
        const provided = sig.trim().toLowerCase();
        if (provided.length !== expected.length) return false;
        return timingSafeEqual(
            Buffer.from(expected, 'utf8'),
            Buffer.from(provided, 'utf8'),
        );
    }

    private digest(key: string, exp: number): string {
        return createHmac('sha256', this.secret)
            .update(`${key}\n${exp}`)
            .digest('hex');
    }

    private async ttlSeconds(): Promise<number> {
        const configured = await this.settings.getNumber(
            'storage.oss.signedUrlTtlSeconds',
            DEFAULT_TTL_SECONDS,
        );
        return Math.min(Math.max(configured, MIN_TTL_SECONDS), MAX_TTL_SECONDS);
    }
}
