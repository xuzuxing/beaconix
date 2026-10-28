import { HttpChecker } from './http.checker';
import { TcpChecker } from './tcp.checker';

/**
 * The local executor runs on our servers: it must refuse private targets even
 * though the plain checker specs opt into loopback targets for transport
 * coverage.
 */
describe('local checker address guard', () => {
    const original = process.env.MONITOR_ALLOW_PRIVATE_TARGETS;

    beforeEach(() => {
        delete process.env.MONITOR_ALLOW_PRIVATE_TARGETS;
    });

    afterAll(() => {
        if (original === undefined) {
            delete process.env.MONITOR_ALLOW_PRIVATE_TARGETS;
        } else {
            process.env.MONITOR_ALLOW_PRIVATE_TARGETS = original;
        }
    });

    it('refuses a loopback HTTP target', async () => {
        const result = await new HttpChecker().check(
            'http://127.0.0.1:9/',
            500,
            200,
        );

        expect(result.success).toBe(false);
        expect(result.evaluated).toBe(false);
        expect(result.failureKind).toBe('CONFIGURATION');
        expect(result.error).toContain('not a public address');
    });

    it('refuses a private HTTP target behind a hostname', async () => {
        const result = await new HttpChecker().check(
            'http://localhost:9/',
            500,
            200,
        );

        expect(result.success).toBe(false);
        expect(result.evaluated).toBe(false);
        expect(result.failureKind).toBe('CONFIGURATION');
    });

    it('refuses a loopback TCP target', async () => {
        const result = await new TcpChecker().check('127.0.0.1:9', 500);

        expect(result.success).toBe(false);
        expect(result.evaluated).toBe(false);
        expect(result.failureKind).toBe('CONFIGURATION');
        expect(result.error).toContain('not a public address');
    });
});
