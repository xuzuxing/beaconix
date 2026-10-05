import {
    buildMsgSignature,
    checkMsgSignature,
    checkSignature,
    decryptMessage,
    encryptMessage,
    sha1Hex,
} from './wechat-signature.util';

/** 43-character EncodingAESKey used by the fixed test vectors below. */
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

/**
 * Pre-computed vector: sha1('1234567890abcdeftesttoken'), i.e. the sorted
 * `[timestamp, nonce, token]` concatenation for
 * token=testtoken, timestamp=1234567890, nonce=abcdef.
 */
const SIGNATURE_VECTOR = '454c387bdb6a4da38448d5cb3c3c2e34b03c01be';

/**
 * Pre-computed ciphertext for `hello` + appId `wx123`, produced with a
 * zeroed 16-byte random prefix under the same PKCS#7 + AES-256-CBC scheme.
 */
const MESSAGE_VECTOR = 'sLR/n4SbHXvKAdlBki8FGIrqqqCc0C/BnFt+k7asN3o=';

describe('wechat-signature.util', () => {
    describe('sha1Hex / checkSignature', () => {
        it('computes the expected SHA1 vector', () => {
            expect(sha1Hex('1234567890abcdeftesttoken')).toBe(SIGNATURE_VECTOR);
        });

        it('accepts a matching signature in any case', () => {
            expect(
                checkSignature(
                    'testtoken',
                    '1234567890',
                    'abcdef',
                    SIGNATURE_VECTOR,
                ),
            ).toBe(true);

            expect(
                checkSignature(
                    'testtoken',
                    '1234567890',
                    'abcdef',
                    SIGNATURE_VECTOR.toUpperCase(),
                ),
            ).toBe(true);
        });

        it('rejects a mismatching or missing signature', () => {
            expect(
                checkSignature('testtoken', '1234567890', 'abcdef', 'deadbeef'),
            ).toBe(false);

            expect(
                checkSignature('testtoken', '1234567890', 'abcdef', ''),
            ).toBe(false);
        });
    });

    describe('msg signature (safe mode)', () => {
        /**
         * sha1('1234567890ENCRYPTEDabcdeftoken'), i.e. the sorted
         * `[timestamp, encrypted, nonce, token]` concatenation.
         */
        const MSG_SIGNATURE_VECTOR = 'be19eeb54ddbdb99b5b1d36dd260eebfdce5d2c7';

        it('computes the expected 4-part vector', () => {
            expect(
                buildMsgSignature('token', '1234567890', 'abcdef', 'ENCRYPTED'),
            ).toBe(MSG_SIGNATURE_VECTOR);
        });

        it('accepts a matching signature in any case', () => {
            expect(
                checkMsgSignature(
                    'token',
                    '1234567890',
                    'abcdef',
                    'ENCRYPTED',
                    MSG_SIGNATURE_VECTOR,
                ),
            ).toBe(true);

            expect(
                checkMsgSignature(
                    'token',
                    '1234567890',
                    'abcdef',
                    'ENCRYPTED',
                    MSG_SIGNATURE_VECTOR.toUpperCase(),
                ),
            ).toBe(true);
        });

        it('rejects a mismatching or missing signature', () => {
            expect(
                checkMsgSignature(
                    'token',
                    '1234567890',
                    'abcdef',
                    'ENCRYPTED',
                    'deadbeef',
                ),
            ).toBe(false);

            expect(
                checkMsgSignature(
                    'token',
                    '1234567890',
                    'abcdef',
                    'ENCRYPTED',
                    '',
                ),
            ).toBe(false);
        });
    });

    describe('message encryption', () => {
        it('decrypts a known safe-mode message', () => {
            expect(decryptMessage(MESSAGE_VECTOR, AES_KEY, 'wx123')).toBe(
                'hello',
            );
        });

        it('round-trips a non-ASCII message', () => {
            const message = '服务异常: 订单API';

            const encrypted = encryptMessage(message, AES_KEY, 'wx123');

            expect(decryptMessage(encrypted, AES_KEY, 'wx123')).toBe(message);
        });

        it('rejects a message encrypted for another appId', () => {
            const encrypted = encryptMessage('hello', AES_KEY, 'wx123');

            expect(() => decryptMessage(encrypted, AES_KEY, 'wx999')).toThrow(
                'appId',
            );
        });

        it('rejects an invalid EncodingAESKey', () => {
            expect(() =>
                decryptMessage('payload', 'too-short', 'wx123'),
            ).toThrow('43 characters');
        });
    });
});
