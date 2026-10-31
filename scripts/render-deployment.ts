import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { httpPath, normalizeGlobalPrefix } from '../src/config/http-path';

const args = process.argv.slice(2);
const prefixIndex = args.indexOf('--prefix');
const outputIndex = args.indexOf('--output');
if (
    prefixIndex < 0 ||
    outputIndex < 0 ||
    args[prefixIndex + 1] === undefined ||
    !args[outputIndex + 1]
) {
    throw new Error(
        'Usage: tsx scripts/render-deployment.ts --prefix /api --output .tmp/deployment.yaml (use --prefix "" for root)',
    );
}
const prefix = normalizeGlobalPrefix(args[prefixIndex + 1]);
const source = resolve('deployment.yaml');
const output = resolve(args[outputIndex + 1]);
if (source === output) throw new Error('Render to a separate manifest');
let manifest = readFileSync(source, 'utf8');
manifest = manifest.replace(
    /\/api\/(health\/(?:live|ready)|metrics)/g,
    (_, path: string) => httpPath(prefix, path),
);
manifest = manifest.replace(
    /GLOBAL_PREFIX: "\/api"/,
    `GLOBAL_PREFIX: ${JSON.stringify(prefix)}`,
);
// Ingress has no rewrite: Nest sees the same path the caller used.
manifest = manifest.replace(/path: \/api\s*\n/g, `path: ${prefix || '/'}\n`);
if (!prefix) {
    // A root API cannot share '/' with a SPA in the same Ingress.
    // Remove the SPA fallback; serve the frontend on a separate hostname.
    manifest = manifest.replace(
        /          - path: \/\r?\n            pathType: Prefix\r?\n            backend:\r?\n              service:\r?\n                name: beaconix-web-svc\r?\n                port:\r?\n                  number: 80\r?\n?/g,
        '',
    );
    if (manifest.includes('name: beaconix-web-svc'))
        throw new Error(
            'Root API must not share its fallback with the frontend',
        );
}
for (const path of ['health/live', 'health/ready', 'metrics']) {
    if (!manifest.includes(httpPath(prefix, path)))
        throw new Error(`Missing rendered ${path}`);
}
if (!manifest.includes(`GLOBAL_PREFIX: ${JSON.stringify(prefix)}`))
    throw new Error('Missing prefix config');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, manifest);
console.log(`Deployment manifest rendered: ${output}`);
