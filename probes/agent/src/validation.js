'use strict';

const {
    createCipheriv,
    createDecipheriv,
    createHash,
    hkdfSync,
    randomBytes,
} = require('node:crypto');

const { VALIDATION_INFO } = require('./constants');
const { pullValidation, answerValidation } = require('./api');
const logger = require('./logger');

/**
 * AES-256-GCM key for the validation challenge.
 *
 * The backend only keeps a sha256 hash of the secret (never the plaintext), so
 * both sides derive the key from `sha256(secret)`: the probe hashes its own
 * secret first, the backend feeds the stored hash straight in.
 */
function deriveValidationKey(token) {
    const secretHash = createHash('sha256')
        .update(token, 'utf8')
        .digest('hex');

    return Buffer.from(
        hkdfSync(
            'sha256',
            Buffer.from(secretHash, 'utf8'),
            Buffer.alloc(0),
            Buffer.from(VALIDATION_INFO, 'utf8'),
            32,
        ),
    );
}

function encryptValidationJson(key, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: data.toString('base64'),
    };
}

function decryptValidationJson(key, payload) {
    const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.data, 'base64')),
        decipher.final(),
    ]);

    return JSON.parse(plaintext.toString('utf8'));
}

async function pollAndAnswerValidation(config) {
    let data;
    try {
        data = await pullValidation(config);
    } catch (err) {
        logger.warn(`Validation pull failed: ${err.message}`);
        return null;
    }

    const validation = data && data.validation;
    if (!validation) return null;

    const key = deriveValidationKey(config.token);

    let challenge;
    try {
        challenge = decryptValidationJson(key, validation.challenge);
    } catch (err) {
        logger.warn(`Validation challenge decrypt failed: ${err.message}`);
        return null;
    }

    const answer = encryptValidationJson(key, {
        nonce: challenge.nonce,
        answeredAt: new Date().toISOString(),
    });

    try {
        const result = await answerValidation(
            config,
            validation.validationId,
            answer,
        );
        logger.log(
            `Validation challenge answered: ${
                result && result.ok ? 'OK' : 'FAILED'
            }`,
        );
        return result;
    } catch (err) {
        logger.warn(`Validation answer failed: ${err.message}`);
        return null;
    }
}

module.exports = {
    deriveValidationKey,
    encryptValidationJson,
    decryptValidationJson,
    pollAndAnswerValidation,
};
