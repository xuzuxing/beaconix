import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SettingValueType } from '../../generated/prisma/enums';
import { PrismaService } from '../../infra/database/prisma.service';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
    let service: SettingsService;

    const prisma = {
        setting: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
    };

    beforeEach(async () => {
        jest.clearAllMocks();

        const moduleRef = await Test.createTestingModule({
            providers: [
                SettingsService,
                { provide: PrismaService, useValue: prisma },
            ],
        }).compile();

        service = moduleRef.get(SettingsService);
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

    it('upserts known settings with their default value type', async () => {
        prisma.setting.findUnique.mockResolvedValue(null);
        prisma.setting.upsert.mockResolvedValue({
            key: 'storage.oss.signedUrlTtlSeconds',
            name: 'OSS Signed URL TTL',
            value: 600,
            valueType: SettingValueType.NUMBER,
            description:
                'TTL in seconds for generated OSS signed download URLs.',
            isSecret: false,
            updatedById: 'user_1',
            createdAt: new Date('2026-10-07T00:00:00.000Z'),
            updatedAt: new Date('2026-10-07T00:00:00.000Z'),
        });

        const result = await service.update(
            'storage.oss.signedUrlTtlSeconds',
            { value: '600' },
            'user_1',
        );

        expect(prisma.setting.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { key: 'storage.oss.signedUrlTtlSeconds' },
                create: expect.objectContaining({
                    name: 'OSS Signed URL TTL',
                    value: 600,
                    valueType: SettingValueType.NUMBER,
                    updatedById: 'user_1',
                }),
            }),
        );
        expect(result.value).toBe(600);
        expect(result.isDefault).toBe(false);
    });

    it('rejects values that cannot be normalized to the requested type', async () => {
        prisma.setting.findUnique.mockResolvedValue(null);
        await expect(
            service.update('attachments.maxImageSizeMb', {
                value: 'not-a-number',
                valueType: SettingValueType.NUMBER,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown setting keys', async () => {
        await expect(
            service.update('custom.limit', {
                value: 10,
                valueType: SettingValueType.NUMBER,
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('preserves existing metadata when only value is updated', async () => {
        prisma.setting.findUnique.mockResolvedValue({
            key: 'attachments.maxImageSizeMb',
            name: 'Image Limit',
            value: 8,
            valueType: SettingValueType.NUMBER,
            description: 'Custom description',
            isSecret: false,
            updatedById: 'user_1',
            createdAt: new Date('2026-10-07T00:00:00.000Z'),
            updatedAt: new Date('2026-10-07T00:00:00.000Z'),
        });
        prisma.setting.upsert.mockResolvedValue({
            key: 'attachments.maxImageSizeMb',
            name: 'Image Limit',
            value: 12,
            valueType: SettingValueType.NUMBER,
            description: 'Custom description',
            isSecret: false,
            updatedById: 'user_2',
            createdAt: new Date('2026-10-07T00:00:00.000Z'),
            updatedAt: new Date('2026-10-08T00:00:00.000Z'),
        });

        await service.update(
            'attachments.maxImageSizeMb',
            { value: 12 },
            'user_2',
        );

        expect(prisma.setting.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({
                    name: 'Image Limit',
                    description: 'Custom description',
                    isSecret: false,
                }),
            }),
        );
    });

    it('masks secret values in API entities', async () => {
        prisma.setting.findUnique.mockResolvedValue({
            key: 'storage.publicBaseUrl',
            name: 'Secret URL',
            value: 'https://example.com/private',
            valueType: SettingValueType.STRING,
            description: 'Secret setting',
            isSecret: true,
            updatedById: 'user_1',
            createdAt: new Date('2026-10-07T00:00:00.000Z'),
            updatedAt: new Date('2026-10-07T00:00:00.000Z'),
        });

        await expect(
            service.findOne('storage.publicBaseUrl'),
        ).resolves.toMatchObject({
            value: '********',
            isSecret: true,
        });
    });

    it('validates known setting ranges and enums', async () => {
        prisma.setting.findUnique.mockResolvedValue(null);

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
        prisma.setting.findUnique
            .mockResolvedValueOnce({
                value: 8,
            })
            .mockResolvedValueOnce(null);
        prisma.setting.upsert.mockResolvedValue({
            key: 'attachments.maxImageSizeMb',
            name: 'Max Image Upload Size',
            value: 16,
            valueType: SettingValueType.NUMBER,
            description: 'Maximum image upload size in MB.',
            isSecret: false,
            updatedById: 'user_1',
            createdAt: new Date('2026-10-07T00:00:00.000Z'),
            updatedAt: new Date('2026-10-07T00:00:00.000Z'),
        });

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
