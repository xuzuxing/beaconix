import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SettingValueType } from '../../../generated/prisma/enums';

/** 配置项的候选项：前端据此把自由输入换成下拉 */
export class SettingOptionEntity {
    @ApiProperty({ example: 'OSS 对象存储' })
    label: string;

    @ApiProperty({ example: 'oss' })
    value: string;

    constructor(partial: Partial<SettingOptionEntity>) {
        Object.assign(this, partial);
    }
}

export class SettingEntity {
    @ApiProperty({ example: 'storage.driver' })
    key: string;

    @ApiProperty({ example: '存储驱动' })
    name: string;

    @ApiProperty({
        example: 'storage',
        description: '平台配置页的 tab 归属，由后端内置定义给出，不入库',
    })
    group: string;

    @ApiPropertyOptional({
        type: String,
        description:
            'tab 内的二级分组（小标题/折叠面板），由后端内置定义给出，不入库；缺省表示直接挂在 tab 顶层',
    })
    section?: string;

    @ApiProperty({
        oneOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'object' },
            { type: 'array', items: {} },
        ],
        nullable: true,
        example: 'local',
        description: 'isSecret 的项读回时恒为 null，不回显原值',
    })
    value: unknown;

    @ApiProperty({ enum: SettingValueType, example: SettingValueType.STRING })
    valueType: SettingValueType;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        example: '启用中的附件存储驱动：local 或 oss。',
    })
    description: string | null;

    @ApiProperty({ example: false })
    isSecret: boolean;

    @ApiProperty({
        example: true,
        description:
            '从未被平台覆盖过（不存在覆盖行）为 true，改回默认值后仍是 false',
    })
    isDefault: boolean;

    @ApiPropertyOptional({ type: String, nullable: true, example: 'user_xxx' })
    updatedById: string | null;

    @ApiPropertyOptional({
        type: String,
        format: 'date-time',
        nullable: true,
        example: '2026-10-07T12:00:00.000Z',
    })
    createdAt: Date | null;

    @ApiPropertyOptional({
        type: String,
        format: 'date-time',
        nullable: true,
        example: '2026-10-07T12:00:00.000Z',
    })
    updatedAt: Date | null;

    @ApiPropertyOptional({
        type: [SettingOptionEntity],
        description: '候选项；给了就渲染下拉，不给则是普通输入框',
    })
    options?: SettingOptionEntity[];

    @ApiPropertyOptional({ type: Number, example: 1 })
    min?: number;

    @ApiPropertyOptional({ type: Number, example: 500 })
    max?: number;

    constructor(partial: Partial<SettingEntity>) {
        Object.assign(this, partial);
    }
}
