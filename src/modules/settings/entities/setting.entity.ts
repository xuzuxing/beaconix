import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SettingValueType } from '../../../generated/prisma/enums';

export class SettingEntity {
    @ApiProperty({ example: 'storage.driver' })
    key: string;

    @ApiProperty({ example: 'Storage Driver' })
    name: string;

    @ApiProperty({
        oneOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'object' },
            { type: 'array', items: {} },
        ],
        example: 'local',
    })
    value: unknown;

    @ApiProperty({ enum: SettingValueType, example: SettingValueType.STRING })
    valueType: SettingValueType;

    @ApiPropertyOptional({
        example: 'Active attachment storage driver: local or oss.',
    })
    description: string | null;

    @ApiProperty({ example: false })
    isSecret: boolean;

    @ApiPropertyOptional({ example: 'user_xxx' })
    updatedById: string | null;

    @ApiProperty({ example: true })
    isDefault: boolean;

    @ApiPropertyOptional({ example: '2026-10-07T12:00:00.000Z' })
    createdAt: Date | null;

    @ApiPropertyOptional({ example: '2026-10-07T12:00:00.000Z' })
    updatedAt: Date | null;

    constructor(partial: Partial<SettingEntity>) {
        Object.assign(this, partial);
    }
}
