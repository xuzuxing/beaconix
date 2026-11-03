import {
    createRumErrorFingerprint,
    RUM_FINGERPRINT_VERSION,
} from './error-fingerprint';

describe('createRumErrorFingerprint', () => {
    it('is stable within an app and separates apps', () => {
        const first = createRumErrorFingerprint('app-a', 'Error', 'failed');
        expect(first).toHaveLength(64);
        expect(first).toBe(
            createRumErrorFingerprint('app-a', 'Error', 'failed'),
        );
        expect(first).not.toBe(
            createRumErrorFingerprint('app-b', 'Error', 'failed'),
        );
        expect(RUM_FINGERPRINT_VERSION).toBe(1);
    });
});
