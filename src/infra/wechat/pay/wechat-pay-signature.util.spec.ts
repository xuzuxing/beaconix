import { createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto';
import { WechatConfigurationError } from '../wechat.types';
import {
    buildAuthorizationHeader,
    buildRequestSignMessage,
    buildResponseSignMessage,
    decryptResource,
    resolvePem,
    signMessage,
    verifyMessage,
} from './wechat-pay-signature.util';

const API_V3_KEY = '0123456789abcdef0123456789abcdef';

let privateKeyPem: string;
let publicKeyPem: string;

/** Produces a WeChat-style encrypted resource (AES-256-GCM + trailing tag). */
function encryptForApiV3(
    key: string,
    plaintext: string,
    associatedData = 'transaction',
) {
    const nonce = randomBytes(6).toString('hex'); // 12 ASCII chars = 12 bytes
    const cipher = createCipheriv(
        'aes-256-gcm',
        Buffer.from(key, 'utf8'),
        Buffer.from(nonce, 'utf8'),
    );
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
        nonce,
        associated_data: associatedData,
    };
}

describe('wechat-pay-signature.util', () => {
    beforeAll(() => {
        const pair = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });

        privateKeyPem = pair.privateKey;
        publicKeyPem = pair.publicKey;
    });

    describe('sign message layout', () => {
        it('builds the request string to sign', () => {
            expect(
                buildRequestSignMessage({
                    method: 'post',
                    urlPath: '/v3/pay/transactions/jsapi',
                    timestamp: '1554208460',
                    nonce: '593BEC0C930BF1AFEB40B4A08C8FB242',
                    body: '{"a":1}',
                }),
            ).toBe(
                'POST\n/v3/pay/transactions/jsapi\n1554208460\n593BEC0C930BF1AFEB40B4A08C8FB242\n{"a":1}\n',
            );
        });

        it('defaults the body to an empty last line', () => {
            // The body line is always terminated by `\n`, so an empty body
            // leaves two consecutive newlines at the end of the string.
            expect(
                buildRequestSignMessage({
                    method: 'GET',
                    urlPath: '/v3/certificates',
                    timestamp: '1',
                    nonce: 'n',
                }),
            ).toBe('GET\n/v3/certificates\n1\nn\n\n');
        });

        it('builds the response string to verify', () => {
            expect(buildResponseSignMessage('1', 'n', '{}')).toBe('1\nn\n{}\n');
        });
    });

    describe('signMessage / verifyMessage', () => {
        it('round-trips a signature', () => {
            const message = 'POST\n/v3/pay/transactions/jsapi\n1\nn\n{}\n';
            const signature = signMessage(message, privateKeyPem);

            expect(verifyMessage(message, signature, publicKeyPem)).toBe(true);
        });

        it('rejects a tampered message', () => {
            const signature = signMessage('original', privateKeyPem);

            expect(verifyMessage('tampered', signature, publicKeyPem)).toBe(
                false,
            );
        });

        it('rejects a malformed public key instead of throwing', () => {
            expect(verifyMessage('original', 'not-a-signature', 'nope')).toBe(
                false,
            );
        });
    });

    describe('buildAuthorizationHeader', () => {
        it('follows the WECHATPAY2-SHA256-RSA2048 schema', () => {
            const header = buildAuthorizationHeader({
                mchId: '1900000001',
                serialNo: 'SERIAL-1',
                privateKeyPem,
                method: 'POST',
                urlPath: '/v3/pay/transactions/jsapi',
                body: '{}',
                timestamp: '1554208460',
                nonce: 'NONCE-1',
            });

            expect(header).toMatch(
                /^WECHATPAY2-SHA256-RSA2048 mchid="1900000001",nonce_str="NONCE-1",signature="[^"]+",timestamp="1554208460",serial_no="SERIAL-1"$/,
            );
        });

        it('signs the same string the client would send', () => {
            const header = buildAuthorizationHeader({
                mchId: '1900000001',
                serialNo: 'SERIAL-1',
                privateKeyPem,
                method: 'POST',
                urlPath: '/v3/pay/transactions/jsapi',
                body: '{}',
                timestamp: '1554208460',
                nonce: 'NONCE-1',
            });

            const signature = /signature="([^"]+)"/.exec(header)?.[1] ?? '';
            const message = buildRequestSignMessage({
                method: 'POST',
                urlPath: '/v3/pay/transactions/jsapi',
                timestamp: '1554208460',
                nonce: 'NONCE-1',
                body: '{}',
            });

            expect(verifyMessage(message, signature, publicKeyPem)).toBe(true);
        });
    });

    describe('decryptResource', () => {
        it('decrypts an AEAD_AES_256_GCM resource', () => {
            const plaintext = JSON.stringify({ out_trade_no: 'BW1' });
            const resource = encryptForApiV3(API_V3_KEY, plaintext);

            expect(decryptResource(API_V3_KEY, resource)).toBe(plaintext);
        });

        it('fails when the associated data does not match', () => {
            const resource = encryptForApiV3(API_V3_KEY, '{}', 'transaction');

            expect(() =>
                decryptResource(API_V3_KEY, {
                    ...resource,
                    associated_data: 'certificate',
                }),
            ).toThrow();
        });

        it('rejects an APIv3 key that is not 32 bytes', () => {
            const resource = encryptForApiV3(API_V3_KEY, '{}');

            expect(() => decryptResource('short', resource)).toThrow(
                WechatConfigurationError,
            );
        });

        it('rejects an unsupported algorithm', () => {
            const resource = encryptForApiV3(API_V3_KEY, '{}');

            expect(() =>
                decryptResource(API_V3_KEY, {
                    ...resource,
                    algorithm: 'AEAD_AES_128_GCM',
                }),
            ).toThrow('Unsupported WeChat Pay resource algorithm');
        });
    });

    describe('resolvePem', () => {
        it('returns inline PEM content untouched', () => {
            expect(resolvePem(privateKeyPem, 'KEY')).toBe(privateKeyPem);
        });

        it('rejects an empty value', () => {
            expect(() => resolvePem('', 'KEY')).toThrow(
                'KEY is not configured',
            );
        });

        it('rejects a missing file path', () => {
            expect(() =>
                resolvePem('C:/definitely/not/here.pem', 'KEY'),
            ).toThrow('could not be read as a PEM file');
        });
    });
});
