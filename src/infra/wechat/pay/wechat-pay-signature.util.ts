import {
    createDecipheriv,
    createSign,
    createVerify,
    randomBytes,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WechatConfigurationError } from '../wechat.types';
import type { WechatPayEncryptedResource } from './wechat-pay.types';

/** WeChat Pay V3 signature algorithm: SHA256withRSA (PKCS#1 v1.5). */
const SIGN_ALGORITHM = 'RSA-SHA256';
const AUTHORIZATION_SCHEME = 'WECHATPAY2-SHA256-RSA2048';
const API_V3_KEY_LENGTH = 32;
const GCM_AUTH_TAG_LENGTH = 16;

export function currentTimestamp(): string {
    return String(Math.floor(Date.now() / 1000));
}

/** WeChat accepts up to 32 characters for `nonce_str`. */
export function generateNonce(): string {
    return randomBytes(16).toString('hex');
}

/**
 * Reads a PEM secret that may be configured either inline (`-----BEGIN ...`)
 * or as a path to a file on disk.
 */
export function resolvePem(value: string, label: string): string {
    if (!value || value.trim() === '') {
        throw new WechatConfigurationError(`${label} is not configured`);
    }

    if (value.includes('-----BEGIN')) {
        return value;
    }

    try {
        return readFileSync(value, 'utf8');
    } catch (error) {
        throw new WechatConfigurationError(
            `${label} could not be read as a PEM file: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

/**
 * String to sign for a Pay V3 request:
 * `METHOD\nURL\ntimestamp\nnonce\nbody\n`.
 *
 * `urlPath` must include the query string, without the host. The body line is
 * always terminated, so an absent body leaves a blank line before the final
 * newline — WeChat signs the string exactly as laid out above.
 */
export function buildRequestSignMessage(input: {
    method: string;
    urlPath: string;
    timestamp: string;
    nonce: string;
    body?: string;
}): string {
    return [
        input.method.toUpperCase(),
        input.urlPath,
        input.timestamp,
        input.nonce,
        input.body ?? '',
        '',
    ].join('\n');
}

/** String to verify for a Pay V3 response/notification: `timestamp\nnonce\nbody\n`. */
export function buildResponseSignMessage(
    timestamp: string,
    nonce: string,
    body: string,
): string {
    return [timestamp, nonce, body, ''].join('\n');
}

export function signMessage(message: string, privateKeyPem: string): string {
    const signer = createSign(SIGN_ALGORITHM);
    signer.update(message, 'utf8');
    signer.end();
    return signer.sign(privateKeyPem, 'base64');
}

export function verifyMessage(
    message: string,
    signatureBase64: string,
    publicKeyPem: string,
): boolean {
    try {
        const verifier = createVerify(SIGN_ALGORITHM);
        verifier.update(message, 'utf8');
        verifier.end();
        return verifier.verify(publicKeyPem, signatureBase64, 'base64');
    } catch {
        return false;
    }
}

/** Builds the `Authorization` header for a Pay V3 request. */
export function buildAuthorizationHeader(input: {
    mchId: string;
    serialNo: string;
    privateKeyPem: string;
    method: string;
    urlPath: string;
    body?: string;
    timestamp?: string;
    nonce?: string;
}): string {
    const timestamp = input.timestamp ?? currentTimestamp();
    const nonce = input.nonce ?? generateNonce();

    const signature = signMessage(
        buildRequestSignMessage({
            method: input.method,
            urlPath: input.urlPath,
            timestamp,
            nonce,
            body: input.body,
        }),
        input.privateKeyPem,
    );

    return [
        `${AUTHORIZATION_SCHEME} mchid="${input.mchId}"`,
        `nonce_str="${nonce}"`,
        `signature="${signature}"`,
        `timestamp="${timestamp}"`,
        `serial_no="${input.serialNo}"`,
    ].join(',');
}

/**
 * Decrypts a Pay V3 `resource` / `encrypt_certificate` block
 * (AES-256-GCM, key = APIv3 key, ciphertext carries a trailing auth tag).
 */
export function decryptResource(
    apiV3Key: string,
    resource: WechatPayEncryptedResource,
): string {
    if (Buffer.byteLength(apiV3Key, 'utf8') !== API_V3_KEY_LENGTH) {
        throw new WechatConfigurationError(
            'WECHAT_PAY_APIV3_KEY must be exactly 32 bytes',
        );
    }

    if (resource.algorithm && resource.algorithm !== 'AEAD_AES_256_GCM') {
        throw new WechatConfigurationError(
            `Unsupported WeChat Pay resource algorithm "${resource.algorithm}"`,
        );
    }

    const payload = Buffer.from(resource.ciphertext, 'base64');

    if (payload.length <= GCM_AUTH_TAG_LENGTH) {
        throw new WechatConfigurationError(
            'WeChat Pay encrypted resource is too short to contain an auth tag',
        );
    }

    const authTag = payload.subarray(payload.length - GCM_AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(
        0,
        payload.length - GCM_AUTH_TAG_LENGTH,
    );

    const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(apiV3Key, 'utf8'),
        Buffer.from(resource.nonce, 'utf8'),
    );
    decipher.setAuthTag(authTag);

    if (resource.associated_data) {
        decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
    }

    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]).toString('utf8');
}
