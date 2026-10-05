import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto';
import { WechatConfigurationError } from '../wechat.types';

/** WeChat message blocks are 32 bytes and the AES key is 32 bytes. */
const BLOCK_SIZE = 32;
const AES_KEY_LENGTH = 32;
const RANDOM_PREFIX_LENGTH = 16;
const LENGTH_FIELD_LENGTH = 4;

/** Constant-time string comparison that never throws on length mismatch. */
function safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');

    if (leftBuffer.length !== rightBuffer.length) return false;

    return timingSafeEqual(leftBuffer, rightBuffer);
}

export function sha1Hex(input: string): string {
    return createHash('sha1').update(input, 'utf8').digest('hex');
}

/**
 * Verifies the `signature` parameter of a WeChat server configuration
 * callback: `sha1(sort([token, timestamp, nonce]).join(''))`.
 */
export function checkSignature(
    token: string,
    timestamp: string,
    nonce: string,
    signature: string,
): boolean {
    if (!signature) return false;

    const expected = sha1Hex([token, timestamp, nonce].sort().join(''));
    return safeEqual(expected, signature.toLowerCase());
}

/**
 * Signature of an encrypted ("safe mode") message:
 * `sha1(sort([token, timestamp, nonce, encrypt]).join(''))`.
 */
export function buildMsgSignature(
    token: string,
    timestamp: string,
    nonce: string,
    encrypted: string,
): string {
    return sha1Hex([token, timestamp, nonce, encrypted].sort().join(''));
}

/** Verifies a `msg_signature` produced by `buildMsgSignature`. */
export function checkMsgSignature(
    token: string,
    timestamp: string,
    nonce: string,
    encrypted: string,
    signature: string,
): boolean {
    if (!signature) return false;

    return safeEqual(
        buildMsgSignature(token, timestamp, nonce, encrypted),
        signature.toLowerCase(),
    );
}

/** Decodes a 43-character `EncodingAESKey` into its 32-byte AES key. */
export function decodeEncodingAesKey(encodingAesKey: string): Buffer {
    if (encodingAesKey.length !== 43) {
        throw new WechatConfigurationError(
            'EncodingAESKey must be exactly 43 characters',
        );
    }

    const key = Buffer.from(`${encodingAesKey}=`, 'base64');

    if (key.length !== AES_KEY_LENGTH) {
        throw new WechatConfigurationError(
            'EncodingAESKey must decode to a 32-byte AES key',
        );
    }

    return key;
}

function pkcs7Pad(buffer: Buffer): Buffer {
    const padLength = BLOCK_SIZE - (buffer.length % BLOCK_SIZE);
    const padding = Buffer.alloc(padLength, padLength);
    return Buffer.concat([buffer, padding]);
}

function pkcs7Unpad(buffer: Buffer): Buffer {
    if (buffer.length === 0) {
        throw new WechatConfigurationError('Cannot unpad an empty buffer');
    }

    const padLength = buffer[buffer.length - 1];

    if (padLength < 1 || padLength > BLOCK_SIZE || padLength > buffer.length) {
        throw new WechatConfigurationError('Invalid PKCS#7 padding');
    }

    return buffer.subarray(0, buffer.length - padLength);
}

/**
 * Decrypts a WeChat "safe mode" message.
 *
 * Plaintext layout after AES-256-CBC decryption:
 * `random(16) + msgLength(4, big-endian) + message + appId`.
 */
export function decryptMessage(
    encrypted: string,
    encodingAesKey: string,
    appId: string,
): string {
    const key = decodeEncodingAesKey(encodingAesKey);
    const iv = key.subarray(0, 16);

    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);

    const decrypted = pkcs7Unpad(
        Buffer.concat([
            decipher.update(Buffer.from(encrypted, 'base64')),
            decipher.final(),
        ]),
    );

    const messageLength = decrypted.readUInt32BE(RANDOM_PREFIX_LENGTH);
    const messageStart = RANDOM_PREFIX_LENGTH + LENGTH_FIELD_LENGTH;
    const messageEnd = messageStart + messageLength;

    if (messageEnd > decrypted.length) {
        throw new WechatConfigurationError(
            'Decrypted WeChat message is shorter than its declared length',
        );
    }

    const message = decrypted
        .subarray(messageStart, messageEnd)
        .toString('utf8');
    const receivedAppId = decrypted.subarray(messageEnd).toString('utf8');

    if (receivedAppId !== appId) {
        throw new WechatConfigurationError(
            'Decrypted WeChat message appId does not match the configured appId',
        );
    }

    return message;
}

/** Encrypts a reply in WeChat "safe mode" (inverse of `decryptMessage`). */
export function encryptMessage(
    message: string,
    encodingAesKey: string,
    appId: string,
): string {
    const key = decodeEncodingAesKey(encodingAesKey);
    const iv = key.subarray(0, 16);

    const messageBuffer = Buffer.from(message, 'utf8');
    const lengthBuffer = Buffer.alloc(LENGTH_FIELD_LENGTH);
    lengthBuffer.writeUInt32BE(messageBuffer.length, 0);

    const plaintext = pkcs7Pad(
        Buffer.concat([
            randomBytes(RANDOM_PREFIX_LENGTH),
            lengthBuffer,
            messageBuffer,
            Buffer.from(appId, 'utf8'),
        ]),
    );

    const cipher = createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(false);

    return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString(
        'base64',
    );
}
