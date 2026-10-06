import { ApiProperty } from '@nestjs/swagger';
import { AuthResponseEntity } from '../../entities/auth-response.entity';

export class WechatAuthResponseEntity extends AuthResponseEntity {
    @ApiProperty({
        example: false,
        description:
            'True when the WeChat login provisioned a brand-new user account (and starter organization).',
    })
    isNewUser: boolean;

    constructor(partial: Partial<WechatAuthResponseEntity>) {
        super(partial);
        Object.assign(this, partial);
    }
}
