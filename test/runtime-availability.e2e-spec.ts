import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Terminus 12 is native ESM (including import.meta/createRequire). Execute its
// real implementation in Node rather than replacing health checks in Jest.
it('runs the offline native Terminus HTTP suite', async () => {
    const { stdout } = await promisify(execFile)(
        process.execPath,
        [
            '--import',
            'tsx',
            '--test',
            join(__dirname, 'runtime-availability.http.ts'),
        ],
        { timeout: 30000, windowsHide: true },
    );
    expect(stdout).toMatch(/# fail 0/);
    expect(stdout).toMatch(/# tests 6/);
}, 35000);
