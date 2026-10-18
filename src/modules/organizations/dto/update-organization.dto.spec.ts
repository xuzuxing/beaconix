import { validate } from 'class-validator';
import { UpdateOrganizationDto } from './update-organization.dto';

function dtoWith(
    values: Partial<UpdateOrganizationDto>,
): UpdateOrganizationDto {
    return Object.assign(new UpdateOrganizationDto(), values);
}

describe('UpdateOrganizationDto', () => {
    it('accepts a self-hosted logo without a TLD', async () => {
        await expect(
            validate(
                dtoWith({
                    logoUrl:
                        'http://localhost:3000/storage/public/teams/logo.png',
                    website: 'http://localhost:5173',
                }),
            ),
        ).resolves.toHaveLength(0);
    });

    it('rejects a script protocol', async () => {
        const errors = await validate(
            dtoWith({ logoUrl: 'javascript:alert(1)' }),
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe('logoUrl');
    });
});
