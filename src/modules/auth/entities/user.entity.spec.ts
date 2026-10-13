import { instanceToPlain } from 'class-transformer';
import { UserEntity } from './user.entity';

describe('UserEntity internal identity version', () => {
    it('never returns the platform authority counter, including direct JSON serialization', () => {
        const entity = new UserEntity({
            id: 'user',
            name: 'User',
            platformAuthorityVersion: 42,
        });
        expect(entity).not.toHaveProperty('platformAuthorityVersion');
        expect(instanceToPlain(entity)).not.toHaveProperty(
            'platformAuthorityVersion',
        );
        expect(JSON.stringify(entity)).not.toContain(
            'platformAuthorityVersion',
        );
    });
});
