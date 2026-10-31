import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GlobalRole } from '../../generated/prisma/enums';
import { SettingsService } from '../../modules/settings/settings.service';
import { MaintenanceGuard } from './maintenance.guard';
import { ConfigService } from '@nestjs/config';

describe('MaintenanceGuard', () => {
    function setup(
        options: {
            maintenance?: boolean;
            path?: string;
            globalRole?: GlobalRole;
            skip?: boolean;
            readError?: boolean;
            prefix?: string;
        } = {},
    ) {
        const setHeader = jest.fn();
        const request: Record<string, unknown> = {
            path: options.path ?? '/api/tasks',
        };
        if (options.globalRole) {
            request.user = { globalRole: options.globalRole };
        }

        const context = {
            switchToHttp: () => ({
                getRequest: () => request,
                getResponse: () => ({ setHeader }),
            }),
            getHandler: () => ({}),
            getClass: () => ({}),
        } as unknown as ExecutionContext;

        const settingsService = {
            getBoolean: options.readError
                ? jest.fn().mockRejectedValue(new Error('db down'))
                : jest.fn().mockResolvedValue(options.maintenance ?? false),
        };

        const reflector = {
            getAllAndOverride: jest.fn().mockReturnValue(options.skip ?? false),
        } as unknown as Reflector;

        return {
            guard: new MaintenanceGuard(
                reflector,
                settingsService as unknown as SettingsService,
                new ConfigService({
                    app: { globalPrefix: options.prefix ?? '/api' },
                }),
            ),
            context,
            setHeader,
            settingsService,
        };
    }

    it('lets everything through while maintenance is off', async () => {
        const { guard, context } = setup({ maintenance: false });

        await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('answers 503 with a Retry-After header for regular users', async () => {
        const { guard, context, setHeader } = setup({ maintenance: true });

        await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
        expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
    });

    it('always lets platform super admins through', async () => {
        const { guard, context } = setup({
            maintenance: true,
            globalRole: GlobalRole.SUPER_ADMIN,
        });

        await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('still blocks regular authenticated users', async () => {
        const { guard, context } = setup({
            maintenance: true,
            globalRole: GlobalRole.USER,
        });

        await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });

    it.each([
        '/api/health',
        '/api/health/live',
        '/api/status',
        '/api/status/503',
        '/api/auth/login',
        '/api/auth/refresh',
        '/api/auth/2fa/verify',
        '/api/auth/wechat/miniprogram/scan-login',
        '/api/plans',
        '/api/settings/public',
        '/api/payment/wechat/callback',
        '/api/probes/heartbeat',
        '/api/probes/results',
    ])('keeps %s reachable during maintenance', async (path) => {
        const { guard, context } = setup({ maintenance: true, path });

        await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('does not let the /api/status prefix cover unrelated routes', async () => {
        const { guard, context } = setup({
            maintenance: true,
            path: '/api/status-pages/some-slug-admin',
        });

        await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });

    it('blocks routes outside the exempt list', async () => {
        for (const path of [
            '/api/tasks',
            '/api/admin/settings',
            '/api/invitations/token-1',
            '/api/developer/v1/monitors',
        ]) {
            const { guard, context } = setup({ maintenance: true, path });
            await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
        }
    });

    it('honours the @SkipMaintenance() decorator', async () => {
        const { guard, context, settingsService } = setup({
            maintenance: true,
            skip: true,
        });

        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(settingsService.getBoolean).not.toHaveBeenCalled();
    });

    it.each(['/backend', ''])(
        'exempts operational routes under prefix %j before settings access',
        async (prefix) => {
            const { guard, context, settingsService } = setup({
                prefix,
                path: `${prefix}/health/live`,
                maintenance: true,
            });
            await expect(guard.canActivate(context)).resolves.toBe(true);
            expect(settingsService.getBoolean).not.toHaveBeenCalled();
            const old = setup({
                prefix,
                path: '/api/health/live',
                maintenance: true,
            });
            await expect(
                old.guard.canActivate(old.context),
            ).rejects.toBeInstanceOf(ServiceUnavailableException);
        },
    );

    it('fails open when the setting cannot be read', async () => {
        const { guard, context } = setup({
            maintenance: true,
            readError: true,
        });

        await expect(guard.canActivate(context)).resolves.toBe(true);
    });
});
