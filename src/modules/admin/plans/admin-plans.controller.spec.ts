import { Test, TestingModule } from '@nestjs/testing';
import { SuperAdminGuard } from '../../../common/guards';
import { AdminPlansController } from './admin-plans.controller';
import { AdminPlansService } from './admin-plans.service';

describe('AdminPlansController', () => {
    let controller: AdminPlansController;
    let service: {
        findAll: jest.Mock;
        findOne: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        remove: jest.Mock;
    };

    beforeEach(async () => {
        service = {
            findAll: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminPlansController],
            providers: [{ provide: AdminPlansService, useValue: service }],
        })
            .overrideGuard(SuperAdminGuard)
            .useValue({ canActivate: () => true })
            .compile();

        controller = module.get<AdminPlansController>(AdminPlansController);
    });

    it('should be defined', () => {
        expect(controller).toBeDefined();
    });

    it('delegates every admin plan action to the service', async () => {
        const createDto = {
            code: 'PRO',
            name: '专业版',
            terms: [
                { cycle: 'MONTHLY' as const, durationDays: 30, price: 2900 },
            ],
        };

        await controller.findAll();
        expect(service.findAll).toHaveBeenCalled();

        await controller.findOne('plan-1');
        expect(service.findOne).toHaveBeenCalledWith('plan-1');

        await controller.create(createDto);
        expect(service.create).toHaveBeenCalledWith(createDto);

        await controller.update('plan-1', { enabled: false });
        expect(service.update).toHaveBeenCalledWith('plan-1', {
            enabled: false,
        });

        await controller.remove('plan-1');
        expect(service.remove).toHaveBeenCalledWith('plan-1');
    });
});
