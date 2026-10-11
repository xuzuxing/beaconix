import { DeveloperProbesController } from './developer-probes.controller';

function createController() {
    const probes = {
        create: jest.fn(),
        remove: jest.fn(),
        rotateSecret: jest.fn(),
    };
    return {
        controller: new DeveloperProbesController(probes as never),
        probes,
    };
}

describe('DeveloperProbesController credential actors', () => {
    const actor = {
        sub: 'actor',
        email: 'actor@example.com',
        globalRole: 'USER' as const,
    };

    it('passes the authenticated actor on enrollment, rotation and removal', async () => {
        const { controller, probes } = createController();
        const dto = {
            name: 'Probe',
            provider: 'CUSTOM' as const,
            region: 'test',
            callbackUrl: 'https://example.com',
        };
        await controller.create('org', dto, actor);
        await controller.rotateSecret('org', 'probe', actor);
        await controller.remove('org', 'probe', actor);
        expect(probes.create).toHaveBeenCalledWith('org', dto, 'actor');
        expect(probes.rotateSecret).toHaveBeenCalledWith(
            'org',
            'probe',
            'actor',
        );
        expect(probes.remove).toHaveBeenCalledWith('org', 'probe', 'actor');
    });

    it('still accepts an organization key whose creator no longer exists', async () => {
        const { controller, probes } = createController();
        await controller.rotateSecret('org', 'probe', undefined);
        expect(probes.rotateSecret).toHaveBeenCalledWith(
            'org',
            'probe',
            undefined,
        );
    });
});
