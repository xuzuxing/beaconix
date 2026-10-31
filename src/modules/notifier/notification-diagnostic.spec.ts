import { notificationDiagnostic } from './notification-diagnostic';

describe('notification diagnostics', () => {
    it('removes known raw and URL-encoded channel credentials, including webhook path tokens', () => {
        const config = {
            webhookUrl:
                'https://open.feishu.cn/open-apis/bot/v2/hook/path-token',
            secret: 'sign+/secret',
            nested: { appSecret: 'app-secret' },
        };
        const result = notificationDiagnostic(
            new Error('path-token sign+/secret sign%2B%2Fsecret app-secret'),
            config,
        );
        expect(result).not.toMatch(/path-token|sign\+|sign%2B|app-secret/);
        expect(result).toContain('[REDACTED]');
    });
    it('redacts query values even when a provider echoes only the bot key', () => {
        expect(
            notificationDiagnostic(new Error('bot-key: denied'), {
                webhookUrl:
                    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=bot-key',
            }),
        ).toBe('[REDACTED]: denied');
    });
    it('preserves useful messages without retaining the original exception', () => {
        expect(notificationDiagnostic(new Error('HTTP 500'), {})).toBe(
            'HTTP 500',
        );
        expect(notificationDiagnostic('unavailable', null)).toBe('unavailable');
    });
    it('redacts the trimmed credential actually sent by channel parsers', () => {
        expect(
            notificationDiagnostic(new Error('real-secret real%2Bsecret'), {
                appSecret: ' real-secret ',
                secret: ' real+secret ',
            }),
        ).toBe('[REDACTED] [REDACTED]');
    });
});
