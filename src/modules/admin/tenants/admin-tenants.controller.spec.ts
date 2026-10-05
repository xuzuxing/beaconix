import { Test, TestingModule } from '@nestjs/testing';
import { SuperAdminGuard } from '../../../common/guards';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';

describe('AdminTenantsController', () => {
    let controller: AdminTenantsController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminTenantsController],
            providers: [
                {
                    provide: AdminTenantsService,
                    useValue: {
                        findAll: jest.fn(),
                        findOne: jest.fn(),
                        toggle: jest.fn(),
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
});
