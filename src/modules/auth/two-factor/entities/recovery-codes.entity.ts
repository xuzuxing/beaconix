import { ApiProperty } from '@nestjs/swagger';

/**
 * Plaintext recovery codes. Returned exactly once — on enable or on
 * regeneration — and never retrievable afterwards.
 */
export class RecoveryCodesEntity {
    @ApiProperty({
        example: ['8H2K-M4XD-9PQA', '7N3C-K9RT-2BPL'],
        type: [String],
    })
    recoveryCodes: string[];

    constructor(partial: Partial<RecoveryCodesEntity>) {
        Object.assign(this, partial);
    }
}
