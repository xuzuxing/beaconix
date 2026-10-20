import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SettingValueType } from '../../generated/prisma/enums';
import { PrismaService } from '../../infra/database/prisma.service';
import { SETTING_DEFINITIONS } from './settings.defaults';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
    let service: SettingsService;
    let warnSpy: jest.SpyInstance;

    const prisma = {
        setting: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
    };

    const row = (overrides: Record<string, unknown> = {}) => ({
        key: 'attachments.maxImageSizeMb',
        name: '图片上传上限（MB）',
        value: 8,
        valueType: SettingValueType.NUMBER,
        description: '单个图片附件的最大体积（MB）。',
        isSecret: false,
        overridden: false,
        updatedById: null,
        createdAt: new Date('2026-10-07T00:00:00.000Z'),
        updatedAt: new Date('2026-10-07T00:00:00.000Z'),
        ...overrides,
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        warnSpy = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => undefined);

        const moduleRef = await Test.createTestingModule({
            providers: [
                SettingsService,
                { provide: PrismaService, useValue: prisma },
            ],
        }).compile();

        service = moduleRef.get(SettingsService);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns built-in defaults when setting rows are absent', async () => {
        prisma.setting.findUnique.mockResolvedValue(null);

        await expect(
            service.getNumber('attachments.maxImageSizeMb', 1),
        ).resolves.toBe(8);
        await expect(service.getString('storage.driver', 'oss')).resolves.toBe(
            'local',
        );
    });

    it('assigns every built-in setting to a tab group', async () => {
        prisma.setting.findMany.mockResolvedValue([]);

        const settings = await service.findAll();
        const byKey = new Map(settings.map((item) => [item.key, item]));

        expect(byKey.get('storage.driver')?.group).toBe('storage');
        expect(byKey.get('storage.oss.signedUrlTtlSeconds')?.group).toBe(
            'storage',
        );
        expect(byKey.get('attachments.maxPdfSizeMb')?.group).toBe(
            'attachments',
        );
        expect(byKey.get('develop.configGroup')?.group).toBe('develop');
        expect(settings.every((item) => Boolean(item.group))).toBe(true);
    });

    it('derives the tab sub-section metadata from the key', async () => {
        prisma.setting.findMany.mockResolvedValue([]);

        const settings = await service.findAll();
        const byKey = new Map(settings.map((item) => [item.key, item]));

        // 没显式声明 section 时按 key 的第二段归类
        expect(byKey.get('wechat.pay.mchId')?.section).toBe('pay');
        expect(byKey.get('wechat.miniprogram.appId')?.section).toBe(
            'miniprogram',
        );
        expect(byKey.get('wechat.scanLogin.page')?.section).toBe('scanLogin');

        const wechat = settings.filter((item) => item.group === 'wechat');
        expect(wechat).toHaveLength(26);
        // 顺序即 key 首次出现的顺序，展示文案由前端按 key 做 i18n
        expect([...new Set(wechat.map((item) => item.section))]).toEqual([
            'pay',
            'miniprogram',
            'website',
            'scanLogin',
            'officialAccount',
            'work',
            'http',
        ]);

        // 全或无：storage 里混着两层 key（storage.driver），整组保持平铺，
        // 避免「带标题的块」与「无标题的项」混排
        expect(byKey.get('storage.driver')?.section).toBeUndefined();
        expect(byKey.get('storage.oss.endpoint')?.section).toBeUndefined();
        // 本来就是两层的 tab 不受影响
        expect(byKey.get('smtp.host')?.section).toBeUndefined();
        expect(byKey.get('develop.configGroup')?.section).toBeUndefined();
    });

    it('derives sections for non-built-in rows as well', async () => {
        prisma.setting.findMany.mockResolvedValue([
            row({ key: 'custom.alpha.one', name: 'A1', overridden: true }),
            row({ key: 'custom.alpha.two', name: 'A2', overridden: true }),
            row({ key: 'custom.flat', name: 'Flat', overridden: true }),
        ]);

        const settings = await service.findAll();
        const custom = settings.filter((item) => item.group === 'custom');

        // 三条都是 custom 组，含一条两层 key → 全或无，整组平铺
        expect(custom.every((item) => item.section === undefined)).toBe(true);
    });

    it('keeps the alipay tab flat, with no sub-sections', async () => {
        prisma.setting.findMany.mockResolvedValue([]);

        const settings = await service.findAll();
        const alipay = settings.filter((item) => item.group === 'alipay');

        expect(alipay.map((item) => item.key)).toEqual([
            'alipay.appId',
            'alipay.privateKey',
            'alipay.publicKey',
            'alipay.gateway',
            'alipay.signType',
            'alipay.sandbox',
            'alipay.notifyUrl',
            'alipay.returnUrl',
            'alipay.mock',
        ]);
        // 全部两层 key → 推断规则下整组平铺，不会出现只有一个分组的冗余标题
        expect(alipay.every((item) => item.section === undefined)).toBe(true);
        // 只有应用私钥是密文项
        expect(
            alipay.filter((item) => item.isSecret).map((item) => item.key),
        ).toEqual(['alipay.privateKey']);
        // 签名算法给出候选值，供前端渲染下拉
        expect(
            alipay.find((item) => item.key === 'alipay.signType')?.options,
        ).toEqual([
            { label: 'RSA2（推荐）', value: 'RSA2' },
            { label: 'RSA（兼容旧应用）', value: 'RSA' },
        ]);
        // 模拟支付与微信保持一致的默认：默认开启，避免误真扣款
        expect(alipay.find((item) => item.key === 'alipay.mock')?.value).toBe(
            true,
        );
    });

    it('reports only the values the admin page actually overrode', async () => {
        prisma.setting.findUnique.mockImplementation(
            (args: { where: { key: string } }) => {
                if (args.where.key === 'wechat.pay.mchId') {
                    return Promise.resolve({
                        value: 'mch-db',
                        overridden: true,
                    });
                }
                if (args.where.key === 'wechat.miniprogram.appId') {
                    // seed 写入的内置行：存在但没被改过，必须继续回退 env
                    return Promise.resolve({
                        value: 'wx-seed',
                        overridden: false,
                    });
                }
                return Promise.resolve(null);
            },
        );

        await expect(
            service.getOverriddenValue('wechat.pay.mchId'),
        ).resolves.toBe('mch-db');
        await expect(
            service.getOverriddenValue('wechat.miniprogram.appId'),
        ).resolves.toBeUndefined();
        await expect(
            service.getOverriddenValue('wechat.website.appId'),
        ).resolves.toBeUndefined();
    });

    it('publishes enum candidates and numeric bounds as options', async () => {
        prisma.setting.findMany.mockResolvedValue([]);

        const settings = await service.findAll();
        const byKey = new Map(settings.map((item) => [item.key, item]));

        expect(byKey.get('storage.driver')?.options).toEqual([
            { label: '本地存储', value: 'local' },
            { label: 'OSS 对象存储', value: 'oss' },
        ]);
        expect(byKey.get('storage.publicBaseUrl')?.options).toBeUndefined();
        expect(byKey.get('attachments.maxImageSizeMb')).toMatchObject({
            min: 1,
            max: 500,
        });
    });

    it('serves settings in definition order and derives the tab list', async () => {
        prisma.setting.findMany.mockResolvedValue([]);

        const settings = await service.findAll();
        const keys = settings.map((item) => item.key);
        const byKey = new Map(settings.map((item) => [item.key, item]));

        // 顺序来自 SETTING_DEFINITIONS 的定义顺序，而不是 key 的字母序
        expect(keys[0]).toBe('system.siteName');
        expect(keys.indexOf('system.siteName')).toBeLessThan(
            keys.indexOf('develop.apiDocsUrl'),
        );
        expect(keys.indexOf('develop.apiDocsUrl')).toBeLessThan(
            keys.indexOf('storage.driver'),
        );

        expect(byKey.get('system.siteName')?.group).toBe('system');
        expect(byKey.get('smtp.port')).toMatchObject({
            group: 'smtp',
            value: 587,
            min: 1,
            max: 65535,
        });
        expect(byKey.get('smtp.secure')).toMatchObject({
            group: 'smtp',
            value: false,
            valueType: SettingValueType.BOOLEAN,
        });
        expect(byKey.get('smtp.fromAddress')).toMatchObject({
            group: 'smtp',
            value: '',
            valueType: SettingValueType.STRING,
        });
        expect(byKey.get('develop.debugMode')?.group).toBe('develop');
        expect(byKey.get('system.defaultLocale')?.options).toEqual([
            { label: '简体中文', value: 'zh-CN' },
            { label: 'English', value: 'en-US' },
        ]);
        // tab 清单的默认值由各定义的 group 派生，新增分组不必再手改
        expect(byKey.get('develop.configGroup')?.value).toEqual([
            'system',
            'smtp',
            'develop',
            'storage',
            'attachments',
            'wechat',
            'alipay',
        ]);
    });

    it('validates email settings', async () => {
        await expect(
            service.update('system.supportEmail', { value: 'not-an-email' }),
        ).rejects.toBeInstanceOf(BadRequestException);

        await expect(
            service.update('smtp.fromAddress', { value: 'not-an-email' }),
        ).rejects.toBeInstanceOf(BadRequestException);

        prisma.setting.upsert.mockResolvedValue(
            row({
                key: 'system.supportEmail',
                name: '客服邮箱',
                value: 'ops@example.com',
                valueType: SettingValueType.STRING,
                description: '页脚与系统邮件里对外提供的联系邮箱。',
            }),
        );

        await expect(
            service.update('system.supportEmail', {
                value: 'ops@example.com',
            }),
        ).resolves.toMatchObject({ group: 'system' });
    });

    it('exposes only the public settings through findPublic', async () => {
        prisma.setting.findMany.mockResolvedValue([]);

        const snapshot = await service.findPublic();

        expect(Object.keys(snapshot).sort()).toEqual([
            'system.defaultLocale',
            'system.faviconUrl',
            'system.footerCopyright',
            'system.icpLicense',
            'system.logoUrl',
            'system.maintenanceMode',
            'system.siteDescription',
            'system.siteName',
            'system.supportEmail',
        ]);
        expect(snapshot['system.siteName']).toBe('Beaconix');
        expect(snapshot['system.maintenanceMode']).toBe(false);
    });

    it('never leaks runtime parameters or secrets through findPublic', async () => {
        prisma.setting.findMany.mockResolvedValue([]);

        const snapshot = await service.findPublic();

        for (const key of [
            'smtp.host',
            'smtp.account',
            'smtp.password',
            'storage.driver',
            'storage.oss.signedUrlTtlSeconds',
            'attachments.maxImageSizeMb',
            'develop.configGroup',
            'develop.debugMode',
            'wechat.pay.mchId',
            'wechat.miniprogram.appSecret',
            'wechat.scanLogin.ttlSeconds',
            'alipay.privateKey',
            'alipay.mock',
        ]) {
            expect(snapshot).not.toHaveProperty(key);
        }
    });

    it('serves the stored value in the public snapshot', async () => {
        prisma.setting.findMany.mockResolvedValue([
            row({
                key: 'system.siteName',
                name: '站点名称',
                value: 'Acme 监控',
                valueType: SettingValueType.STRING,
                description: '浏览器标题、系统邮件与状态页上展示的产品名。',
                overridden: true,
            }),
        ]);

        const snapshot = await service.findPublic();

        expect(snapshot['system.siteName']).toBe('Acme 监控');
    });

    it('never marks a secret setting as public', () => {
        expect(
            SETTING_DEFINITIONS.filter(
                (definition) => definition.isPublic && definition.isSecret,
            ),
        ).toEqual([]);
    });

    it('upserts known settings with their built-in metadata', async () => {
        prisma.setting.upsert.mockResolvedValue(
            row({
                key: 'storage.oss.signedUrlTtlSeconds',
                name: 'OSS 签名地址有效期（秒）',
                value: 600,
                description:
                    '生成的 OSS 签名下载地址有效期（秒）。实际签发时上限为 300 秒。',
                overridden: true,
                updatedById: 'user_1',
            }),
        );

        const result = await service.update(
            'storage.oss.signedUrlTtlSeconds',
            { value: '600' },
            'user_1',
        );

        expect(prisma.setting.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { key: 'storage.oss.signedUrlTtlSeconds' },
                create: expect.objectContaining({
                    name: 'OSS 签名地址有效期（秒）',
                    value: 600,
                    valueType: SettingValueType.NUMBER,
                    updatedById: 'user_1',
                }),
                update: {
                    value: 600,
                    overridden: true,
                    updatedById: 'user_1',
                },
            }),
        );
        expect(result.value).toBe(600);
        expect(result.isDefault).toBe(false);
        expect(result.group).toBe('storage');
    });

    it('treats a seeded row as not overridden', async () => {
        prisma.setting.findUnique.mockResolvedValue(
            row({
                key: 'storage.driver',
                name: '存储驱动',
                value: 'oss',
                valueType: SettingValueType.STRING,
                description: '启用中的附件存储驱动：local 或 oss。',
            }),
        );

        const entity = await service.findOne('storage.driver');

        expect(entity.isDefault).toBe(true);
        expect(entity).not.toHaveProperty('overridden');
    });

    it('never overwrites built-in metadata when only the value is updated', async () => {
        prisma.setting.upsert.mockResolvedValue(
            row({ value: 12, updatedById: 'user_2' }),
        );

        await service.update(
            'attachments.maxImageSizeMb',
            { value: 12 },
            'user_2',
        );

        const call = prisma.setting.upsert.mock.calls[0][0];
        expect(call.update).toEqual({
            value: 12,
            overridden: true,
            updatedById: 'user_2',
        });
        expect(call.update).not.toHaveProperty('name');
        expect(call.update).not.toHaveProperty('description');
        expect(call.update).not.toHaveProperty('valueType');
        expect(call.update).not.toHaveProperty('isSecret');
    });

    it('rejects values that cannot be normalized to the requested type', async () => {
        await expect(
            service.update('attachments.maxImageSizeMb', {
                value: 'not-a-number',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        await expect(
            service.update('attachments.maxImageSizeMb', { value: null }),
        ).rejects.toBeInstanceOf(BadRequestException);

        await expect(
            service.update('develop.configGroup', { value: 'storage' }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects malformed group lists', async () => {
        await expect(
            service.update('develop.configGroup', {
                value: ['storage', 'storage'],
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        await expect(
            service.update('develop.configGroup', { value: ['storage', '  '] }),
        ).rejects.toBeInstanceOf(BadRequestException);

        await expect(
            service.update('develop.configGroup', { value: [] }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('normalizes the stored group list on read', async () => {
        prisma.setting.findUnique.mockResolvedValue(
            row({
                key: 'develop.configGroup',
                name: '平台配置分组',
                value: [' storage ', 'attachments', 'storage', 42],
                valueType: SettingValueType.JSON,
                description:
                    '平台配置页的 tab 清单与顺序，填字符串数组，可任意增删分组。',
            }),
        );

        await expect(
            service.findOne('develop.configGroup'),
        ).resolves.toMatchObject({
            value: ['storage', 'attachments'],
            group: 'develop',
        });
        expect(warnSpy).toHaveBeenCalled();
    });

    it('falls back to the built-in default when the stored group list is unusable', async () => {
        prisma.setting.findUnique.mockResolvedValue(
            row({
                key: 'develop.configGroup',
                name: '平台配置分组',
                value: 'storage,attachments',
                valueType: SettingValueType.JSON,
                description:
                    '平台配置页的 tab 清单与顺序，填字符串数组，可任意增删分组。',
            }),
        );

        await expect(
            service.findOne('develop.configGroup'),
        ).resolves.toMatchObject({
            value: [
                'system',
                'smtp',
                'develop',
                'storage',
                'attachments',
                'wechat',
                'alipay',
            ],
        });
        expect(warnSpy).toHaveBeenCalled();
    });

    it('rejects unknown setting keys', async () => {
        await expect(
            service.update('custom.limit', { value: 10 }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never exposes secret values', async () => {
        prisma.setting.findUnique.mockResolvedValue(
            row({
                key: 'storage.publicBaseUrl',
                name: 'Secret URL',
                value: 'https://example.com/private',
                valueType: SettingValueType.STRING,
                description: 'Secret setting',
                isSecret: true,
            }),
        );

        await expect(
            service.findOne('storage.publicBaseUrl'),
        ).resolves.toMatchObject({
            value: null,
            isSecret: true,
        });
    });

    it('validates known setting ranges and enums', async () => {
        await expect(
            service.update('storage.driver', { value: 'ftp' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            service.update('attachments.maxFilesPerRequest', { value: 0 }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            service.update('storage.publicBaseUrl', {
                value: 'ftp://cdn.test',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('caches runtime values and invalidates them after update', async () => {
        prisma.setting.findUnique.mockResolvedValueOnce({ value: 8 });
        prisma.setting.upsert.mockResolvedValue(row({ value: 16 }));

        await expect(
            service.getNumber('attachments.maxImageSizeMb', 1),
        ).resolves.toBe(8);
        await expect(
            service.getNumber('attachments.maxImageSizeMb', 1),
        ).resolves.toBe(8);
        expect(prisma.setting.findUnique).toHaveBeenCalledTimes(1);

        await service.update('attachments.maxImageSizeMb', { value: 16 });
        prisma.setting.findUnique.mockResolvedValueOnce({ value: 16 });
        await expect(
            service.getNumber('attachments.maxImageSizeMb', 1),
        ).resolves.toBe(16);
    });
});
