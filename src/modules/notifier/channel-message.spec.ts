import { resolveWechatFieldValue } from './channel-config';
import { renderMarkdown, renderText } from './channel-message';
import type { NotificationPayload } from './notifier.types';

const iso = '2026-10-10T13:30:49.009Z';
const payload: NotificationPayload = {
    monitorId: 'monitor-1',
    monitorName: 'Production API',
    monitorType: 'HTTP',
    target: 'https://api.example.com/health',
    organizationId: 'org-1',
    previousStatus: 'UP',
    status: 'DOWN',
    event: 'DOWN',
    failCount: 3,
    latency: 30,
    error: 'connect ECONNREFUSED',
    checkedAt: new Date(iso),
};

describe('notification date formatting', () => {
    it.each([new Date(iso), iso, '2026-10-10T21:30:49.009+08:00'])(
        'renders dates consistently across channel formats: %s',
        (checkedAt) => {
            const input = { ...payload, checkedAt };
            expect(renderText(input)).toContain(`Checked at: ${iso}`);
            expect(renderMarkdown(input)).toContain(`**Checked at:** ${iso}`);
            expect(resolveWechatFieldValue('checkedAt', input)).toBe(iso);
        },
    );

    it('rejects invalid dates instead of using the current time', () => {
        const input = { ...payload, checkedAt: 'invalid-date' };
        expect(() => renderText(input)).toThrow(RangeError);
        expect(() => renderMarkdown(input)).toThrow(RangeError);
        expect(() => resolveWechatFieldValue('checkedAt', input)).toThrow(
            RangeError,
        );
    });
});
