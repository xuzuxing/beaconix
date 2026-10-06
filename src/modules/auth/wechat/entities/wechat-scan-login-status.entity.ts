import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserEntity } from '../../entities/user.entity';

export class WechatScanLoginStatusEntity {
    @ApiProperty({
        enum: ['PENDING', 'SCANNED', 'CONFIRMED', 'EXPIRED'],
        example: 'SCANNED',
        description:
            'PENDING = waiting for scan; SCANNED = mini program opened; CONFIRMED = web login completed; EXPIRED = ticket invalid or consumed.',
    })
    status: 'PENDING' | 'SCANNED' | 'CONFIRMED' | 'EXPIRED';

    @ApiPropertyOptional({
        example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        description: 'Present when status is CONFIRMED.',
    })
    accessToken?: string;

    @ApiPropertyOptional({
        example: 'a1b2c3d4e5f6...',
        description: 'Present when status is CONFIRMED.',
    })
    refreshToken?: string;

    @ApiPropertyOptional({
        type: UserEntity,
        description: 'Present when status is CONFIRMED.',
    })
    user?: UserEntity;

    @ApiPropertyOptional({
        example: false,
        description: 'Present when status is CONFIRMED.',
    })
    isNewUser?: boolean;

    constructor(partial: Partial<WechatScanLoginStatusEntity>) {
        Object.assign(this, partial);
    }
}
