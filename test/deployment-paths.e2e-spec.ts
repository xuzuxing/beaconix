import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

describe('Deployment path rendering (offline)', () => {
    let folder: string;
    beforeEach(async () => {
        folder = await mkdtemp(join(tmpdir(), 'beacon-release-manifest-'));
    });
    afterEach(async () => {
        const target = resolve(folder);
        if (
            dirname(target) !== resolve(tmpdir()) ||
            !target.includes('beacon-release-manifest-')
        )
            throw new Error('Unsafe test cleanup path');
        await rm(target, { recursive: true, force: true });
    });
    it.each([
        ['/api', '/api'],
        [' /backend/ ', '/backend'],
        ['/', ''],
    ])('renders %j consistently', async (raw, prefix) => {
        const output = join(folder, 'deployment.yaml');
        await promisify(execFile)(
            process.execPath,
            [
                '--import',
                'tsx',
                join(__dirname, '../scripts/render-deployment.ts'),
                '--prefix',
                raw,
                '--output',
                output,
            ],
            { cwd: resolve(__dirname, '..'), windowsHide: true },
        );
        const manifest = await readFile(output, 'utf8');
        expect(manifest).toContain(`GLOBAL_PREFIX: ${JSON.stringify(prefix)}`);
        expect(manifest).toContain(`prometheus.io/path: "${prefix}/metrics"`);
        expect(
            manifest.match(new RegExp(`path: ${prefix}/health/live`, 'g')),
        ).toHaveLength(2);
        expect(manifest).toContain(`path: ${prefix}/health/ready`);
        expect(manifest).toContain(`path: ${prefix || '/'}\n`);
        const rootRoutes = manifest.match(/^\s+- path: \/\r?$/gm) ?? [];
        expect(rootRoutes).toHaveLength(1);
        if (!prefix) expect(manifest).not.toContain('name: beaconix-web-svc');
        else expect(manifest).toContain('name: beaconix-web-svc');
        if (prefix !== '/api')
            expect(manifest).not.toMatch(/path: \/api\/(health|metrics)/);
    });
});
