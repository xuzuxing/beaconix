import { Test, TestingModule } from '@nestjs/testing';
import { SuperAdminGuard } from '../../../common/guards';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';

describe('AdminTenantsController', () => {
    let controller: AdminTenantsController;
    let toggle: jest.Mock;

    beforeEach(async () => {
        toggle = jest.fn();
        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminTenantsController],
            providers: [
                {
                    provide: AdminTenantsService,
                    useValue: {
                        findAll: jest.fn(),
                        findOne: jest.fn(),
                        toggle,
                    },
                },
            ],
        })
            .overrideGuard(SuperAdminGuard)
            .useValue({ canActivate: () => true })
            .compile();

        controller = module.get<AdminTenantsController>(AdminTenantsController);
    });

    it('should be defined', () => {
        expect(controller).toBeDefined();
    });

    it('passes the platform administrator to lifecycle notifications', async () => {
        await controller.toggle('org', {
            sub: 'platform-admin',
            email: 'admin@example.com',
            globalRole: 'SUPER_ADMIN',
        });
        expect(toggle).toHaveBeenCalledWith('org', 'platform-admin');
    });
});
