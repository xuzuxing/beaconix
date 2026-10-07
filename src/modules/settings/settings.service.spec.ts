import { BadRequestException } from '@nestjs/common';
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
        await expect(
            service.update('custom.limit', {
                value: 'not-a-number',
                valueType: SettingValueType.NUMBER,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
