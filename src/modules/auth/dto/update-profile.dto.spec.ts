import { validate } from 'class-validator';
import { UpdateProfileDto } from './update-profile.dto';

function dtoWith(avatarUrl: string): UpdateProfileDto {
    return Object.assign(new UpdateProfileDto(), { avatarUrl });
}

describe('UpdateProfileDto', () => {
    it('accepts the API static host on localhost', async () => {
        // The reported case: a self-hosted avatar URL carries no TLD, which a
        // validator.js `@IsUrl()` rejects.
        await expect(
            validate(
                dtoWith(
                    'http://localhost:3000/storage/public/avatars/2026/10/a.png',
                ),
            ),
        ).resolves.toHaveLength(0);
    });

    it('accepts a container host and a public URL', async () => {
        await expect(
            validate(dtoWith('http://beacon:3000/storage/public/a.png')),
        ).resolves.toHaveLength(0);
        await expect(
            validate(dtoWith('https://cdn.example.com/a.png')),
        ).resolves.toHaveLength(0);
    });

    it('rejects non-http protocols and malformed values', async () => {
        for (const value of [
            'javascript:alert(1)',
            'ftp://example.com/a.png',
            'not-a-url',
        ]) {
            const errors = await validate(dtoWith(value));
            expect(errors).toHaveLength(1);
            expect(errors[0].property).toBe('avatarUrl');
            // The message doubles as a "is the new code running?" marker: the
            // old @IsUrl() said "must be a URL address".
            expect(Object.values(errors[0].constraints ?? {}).join(' ')).toBe(
                'avatarUrl must be an http(s) URL',
            );
        }
    });
});
