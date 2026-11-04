import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BreadcrumbBuffer } from '../src/breadcrumbs.js';
import { sanitizeRecord, sanitizeText, stripUrl } from '../src/sanitizer.js';

test('SDK sanitizer removes secrets and URL query data', () => {
    assert.equal(
        sanitizeText('Authorization: Bearer abc.def password=hunter2'),
        'Authorization: [REDACTED] [REDACTED] password=[REDACTED]',
    );
    assert.equal(
        stripUrl('https://example.com/profile?token=secret#details'),
        'https://example.com/profile',
    );
    assert.deepEqual(
        sanitizeRecord({
            url: 'https://api.example.com/users?token=secret',
            authorization: 'Bearer abc',
            nested: { password: 'hunter2' },
        }),
        {
            url: 'https://api.example.com/users',
            authorization: '[REDACTED]',
            nested: { password: '[REDACTED]' },
        },
    );
});

test('breadcrumb buffer keeps the newest sanitized entries', () => {
    const buffer = new BreadcrumbBuffer(2);
    buffer.add({ type: 'console', data: { token: 'first' } });
    buffer.add({ type: 'navigation', data: { url: '/second?secret=1' } });
    buffer.add({ type: 'click', data: { target: '#save' } });

    const entries = buffer.snapshot();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].type, 'navigation');
    assert.deepEqual(entries[0].data, { url: 'https://rum.invalid/second' });
    assert.equal(entries[1].type, 'click');
});
