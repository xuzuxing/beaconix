import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WechatConfig, WechatPayConfig } from '../../../config';
import {
    WECHAT_PAY_BASE_URL,
    WechatHttpClient,
} from '../clients/wechat-http.client';
import { WechatConfigurationError } from '../wechat.types';
import {
    buildAuthorizationHeader,
    currentTimestamp,
    decryptResource,
    generateNonce,
    resolvePem,
} from './wechat-pay-signature.util';
import type { WechatPayCertificatesResponse } from './wechat-pay.types';

const CERTIFICATES_PATH = '/v3/certificates';
/** Platform certificates rotate roughly once a year; refresh twice a day. */
const CERTIFICATE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Resolves the public key used to verify WeChat Pay signatures.
 *
 * Two credential models are supported, in order of preference:
 * 1. WeChat Pay public key (`WECHAT_PAY_PUBLIC_KEY` + `_ID`) — new merchants.
 * 2. Platform certificates downloaded from `/v3/certificates` and decrypted
 *    with the APIv3 key — legacy merchants.
 */
@Injectable()
export class WechatPayCertificateService {
    private readonly logger = new Logger(WechatPayCertificateService.name);

    private certificates = new Map<string, string>();
    private expiresAt = 0;
    private pending: Promise<Map<string, string>> | null = null;

    constructor(
        private readonly http: WechatHttpClient,
        private readonly configService: ConfigService,
    ) {}

    /** Public key (PEM) able to verify a signature carrying `serial`. */
    async getVerifier(serial: string): Promise<string> {
        const config = this.payConfig;

        if (config.publicKey) {
            if (config.publicKeyId && config.publicKeyId !== serial) {
                throw new WechatConfigurationError(
                    `WeChat Pay signature serial "${serial}" does not match WECHAT_PAY_PUBLIC_KEY_ID "${config.publicKeyId}"`,
                );
            }

            return resolvePem(config.publicKey, 'WECHAT_PAY_PUBLIC_KEY');
        }

        const certificates = await this.getPlatformCertificates();
        const certificate = certificates.get(serial);

        if (!certificate) {
            throw new WechatConfigurationError(
                `No WeChat Pay platform certificate found for serial "${serial}"`,
            );
        }

        return certificate;
    }

    /** Forces a platform certificate refresh; returns the number loaded. */
    async refreshPlatformCertificates(): Promise<number> {
        this.expiresAt = 0;
        const certificates = await this.getPlatformCertificates();
        return certificates.size;
    }

    private async getPlatformCertificates(): Promise<Map<string, string>> {
        if (this.certificates.size > 0 && this.expiresAt > Date.now()) {
            return this.certificates;
        }

        if (this.pending) return this.pending;

        this.pending = this.downloadPlatformCertificates()
            .then((certificates) => {
                this.certificates = certificates;
                this.expiresAt = Date.now() + CERTIFICATE_CACHE_TTL_MS;
                return certificates;
            })
            .finally(() => {
                this.pending = null;
            });

        return this.pending;
    }

    private async downloadPlatformCertificates(): Promise<Map<string, string>> {
        const config = this.requireSigningConfig();
        const timestamp = currentTimestamp();
        const nonce = generateNonce();

        const authorization = buildAuthorizationHeader({
            mchId: config.mchId,
            serialNo: config.serialNo,
            privateKeyPem: resolvePem(
                config.privateKey,
                'WECHAT_PAY_PRIVATE_KEY',
            ),
            method: 'GET',
            urlPath: CERTIFICATES_PATH,
            timestamp,
            nonce,
        });

        const response = await this.http.getJson<WechatPayCertificatesResponse>(
            `${WECHAT_PAY_BASE_URL}${CERTIFICATES_PATH}`,
            {
                platform: 'pay',
                headers: { authorization },
                retries: 0,
            },
        );

        const certificates = new Map<string, string>();

        for (const item of response.data ?? []) {
            certificates.set(
                item.serial_no,
                decryptResource(config.apiV3Key, item.encrypt_certificate),
            );
        }

        this.logger.log(
            `Loaded ${certificates.size} WeChat Pay platform certificate(s)`,
        );

        return certificates;
    }

    private requireSigningConfig(): WechatPayConfig {
        const config = this.payConfig;
        const missing = (
            ['mchId', 'serialNo', 'privateKey', 'apiV3Key'] as const
        ).filter((key) => !config[key]);

        if (missing.length > 0) {
            throw new WechatConfigurationError(
                `WeChat Pay platform certificates require: ${missing.join(', ')}`,
            );
        }

        return config;
    }

    private get payConfig(): WechatPayConfig {
        const wechat = this.configService.get<WechatConfig>('wechat');

        if (!wechat) {
            throw new WechatConfigurationError(
                'WeChat config is not registered',
            );
        }

        return wechat.pay;
    }
}
