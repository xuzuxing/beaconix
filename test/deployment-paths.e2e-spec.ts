import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
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

describe('Container initialization (offline)', () => {
    const root = resolve(__dirname, '..');
    const migrationCommand = [
        './node_modules/.bin/prisma',
        'migrate',
        'deploy',
        '--config',
        'prisma.config.ts',
    ];

    it('keeps migration tooling out of the API dependency role', async () => {
        const pkg = JSON.parse(
            await readFile(join(root, 'package.json'), 'utf8'),
        );
        expect(pkg.dependencies.prisma).toBeUndefined();
        expect(pkg.devDependencies.prisma).toBeDefined();
        expect(pkg.dependencies['@prisma/client']).toBeDefined();
        expect(pkg.dependencies['@prisma/adapter-pg']).toBeDefined();
        await expect(
            readFile(join(root, 'docker/migrator/package.json'), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        const workspace = await readFile(
            join(root, 'pnpm-workspace.yaml'),
            'utf8',
        );
        expect(workspace).not.toContain('docker/migrator');
        expect(workspace).not.toContain('injectWorkspacePackages');
        for (const [name, command] of Object.entries(pkg.scripts)) {
            if (name.startsWith('prisma:'))
                expect(command).toMatch(/^pnpm exec prisma /);
        }
    });

    it('removes build-only peers without changing the runtime client peers', () => {
        const { hooks } = createRequire(join(root, 'package.json'))(
            './.pnpmfile.cjs',
        ) as {
            hooks: {
                readPackage: (
                    pkg: Record<string, unknown>,
                ) => Record<string, unknown>;
            };
        };
        const client = hooks.readPackage({
            name: '@prisma/client',
            version: '7.8.0',
            dependencies: { '@prisma/client-runtime-utils': '7.8.0' },
            peerDependencies: { prisma: '*', typescript: '>=5.4.0' },
            peerDependenciesMeta: {
                prisma: { optional: true },
                typescript: { optional: true },
            },
        });
        expect(client.peerDependencies).toEqual({});
        expect(client.peerDependenciesMeta).toEqual({});
        expect(client.dependencies).toEqual({
            '@prisma/client-runtime-utils': '7.8.0',
        });
        const adapter = hooks.readPackage({
            name: '@nestjs-cls/transactional-adapter-prisma',
            version: '2.0.1',
            peerDependencies: {
                prisma: '> 4 < 9',
                '@prisma/client': '> 4 < 9',
                'nestjs-cls': '^7.0.0',
            },
        });
        expect(adapter.peerDependencies).toEqual({
            '@prisma/client': '> 4 < 9',
            'nestjs-cls': '^7.0.0',
        });
        const future = {
            name: '@prisma/client',
            version: '99.0.0',
            peerDependencies: { prisma: '*' },
        };
        expect(hooks.readPackage(future)).toBe(future);
        expect(future.peerDependencies.prisma).toBe('*');
    });

    it('builds independent images and starts Node directly in the default target', async () => {
        const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
        const runner =
            dockerfile.split('FROM node:22-alpine AS runner')[1] ?? '';
        const migrator =
            dockerfile
                .split('FROM node:22-alpine AS migrator')[1]
                ?.split('FROM node:22-alpine AS runner')[0] ?? '';
        expect(JSON.parse(runner.match(/^CMD (.+)$/m)?.[1] ?? '[]')).toEqual([
            'node',
            'dist/src/main',
        ]);
        expect(JSON.parse(migrator.match(/^CMD (.+)$/m)?.[1] ?? '[]')).toEqual(
            migrationCommand,
        );
        expect(dockerfile).toContain('pnpm prune --prod --ignore-scripts');
        expect(dockerfile).toContain(
            'pnpm --dir /prod/migrator add --offline --prod --ignore-scripts --config.auto-install-peers=false',
        );
        expect(dockerfile).toContain(
            'CHECKPOINT_DISABLE=1 ./node_modules/.bin/prisma --version',
        );
        expect(dockerfile).toContain('pnpm-workspace.yaml .pnpmfile.cjs ./');
        expect(runner).toContain(
            'COPY --from=production-deps /app/node_modules ./node_modules',
        );
        expect(runner).not.toMatch(
            /^COPY .*prisma|^COPY .*src\/generated|^RUN .*corepack/gm,
        );
        expect(migrator).toContain(
            'COPY --from=migration-deps /prod/migrator/node_modules ./node_modules',
        );
        expect(migrator).toContain(
            'COPY prisma/migrations ./prisma/migrations',
        );
        expect(migrator).toContain('COPY prisma.config.ts ./prisma.config.ts');
        expect(migrator).not.toContain('/app/dist');
        expect(dockerfile).not.toContain('PRISMA_CLI_QUERY_ENGINE_TYPE');
        expect(dockerfile).not.toContain('find node_modules/.prisma');
    });

    it('gates Kubernetes startup on the dedicated migration image', async () => {
        const manifest = (
            await readFile(join(root, 'deployment.yaml'), 'utf8')
        ).replace(/\r\n/g, '\n');
        const init =
            manifest
                .split('      initContainers:\n')[1]
                ?.split('      containers:\n')[0] ?? '';
        expect(init).toContain('- name: migrate');
        const command = JSON.parse(
            init.match(/command:\s*(\[[^\]]*\])/)?.[1] ?? '[]',
        );
        const args = JSON.parse(
            init.match(/args:\s*(\[[^\]]*\])/)?.[1] ?? '[]',
        );
        expect([...command, ...args]).toEqual(migrationCommand);

        const images = [...manifest.matchAll(/^\s+image:\s+(.+)$/gm)].map(
            (match) => match[1],
        );
        expect(images).toHaveLength(2);
        expect(images).toEqual([
            'registry.xuzuxing.cn/beaconix/beaconix-migrator:latest',
            'registry.xuzuxing.cn/beaconix/beaconix-app:latest',
        ]);
        expect(init).toMatch(
            /name: DATABASE_URL\s+valueFrom:\s+secretKeyRef:\s+name: beaconix-secrets\s+key: DATABASE_URL/,
        );
        expect(init).not.toContain('envFrom:');
        expect(init).not.toContain('volumeMounts:');
        expect(init).not.toContain('NET_RAW');
        expect(init).toContain('allowPrivilegeEscalation: false');
        expect(init).toContain('resources:');
    });

    it('keeps Compose initialization separate and blocks the API on failure', async () => {
        const compose = (
            await readFile(join(root, 'docker-compose.yml'), 'utf8')
        ).replace(/\r\n/g, '\n');
        const init = compose.split('  init:\n')[1]?.split('  app:\n')[0] ?? '';
        const app = compose.split('  app:\n')[1] ?? '';
        expect(compose).toContain('x-app-image: &app-image');
        expect(compose.match(/^ {4}<<: \*app-image$/gm)).toHaveLength(1);
        expect(init).toContain('<<: *migrator-image');
        expect(compose).toContain('target: runner');
        expect(compose).toContain('target: migrator');
        expect(compose).toContain('image: beaconix-migrator');
        expect(
            JSON.parse(init.match(/command:\s*(\[[^\]]*\])/)?.[1] ?? '[]'),
        ).toEqual(migrationCommand);
        expect(init).toContain('restart: "no"');
        expect(init).toMatch(/healthcheck:\s+disable: true/);
        expect(init).toMatch(/postgres:\s+condition: service_healthy/);
        expect(init).not.toContain('ports:');
        expect(init).not.toContain('volumes:');
        expect(app).toMatch(
            /init:\s+condition: service_completed_successfully/,
        );
        expect(app).toMatch(/redis:\s+condition: service_healthy/);
    });

    it('publishes and substitutes both images at the same commit tag in CI', async () => {
        const workflow = await readFile(
            join(root, '.github/workflows/cicd.yml'),
            'utf8',
        );
        expect(workflow).toContain(
            'MIGRATOR_IMAGE_NAME: beaconix/beaconix-migrator',
        );
        expect(workflow).toContain('target: runner');
        expect(workflow).toContain('target: migrator');
        expect(
            workflow.match(/uses: docker\/build-push-action@v6/g),
        ).toHaveLength(2);
        expect(workflow).toContain('IMAGE_TAG="sha-${GITHUB_SHA::7}"');
        expect(workflow).toContain('beaconix-app:latest|${FULL_IMAGE}|g');
        expect(workflow).toContain(
            'beaconix-migrator:latest|${MIGRATOR_IMAGE}|g',
        );
        expect(workflow).toContain('grep -Fq "${MIGRATOR_IMAGE}"');
    });
});
