import { ApiProperty } from '@nestjs/swagger';
import { IsDefined } from 'class-validator';

/**
 * 只覆盖值：`name` / `description` / `group` / `valueType` / `isSecret`
 * 全部由代码里的内置定义维护，不开放给接口修改。
 */
export class UpdateSettingDto {
    @ApiProperty({
        oneOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'object' },
            { type: 'array', items: {} },
        ],
        examples: ['oss', 300, true, { enabled: true }],
        description: '整值覆盖；不接受 null，清空字符串请传空串',
    })
    @IsDefined()
    value: unknown;
}
