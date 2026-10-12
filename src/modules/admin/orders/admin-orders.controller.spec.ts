import { Test, TestingModule } from '@nestjs/testing';
import { SuperAdminGuard } from '../../../common/guards';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';

describe('AdminOrdersController', () => {
    let controller: AdminOrdersController;
    let service: {
        findAll: jest.Mock;
        findOne: jest.Mock;
        cancel: jest.Mock;
        markPaid: jest.Mock;
        refund: jest.Mock;
    };

    beforeEach(async () => {
        service = {
            findAll: jest.fn(),
            findOne: jest.fn(),
            cancel: jest.fn(),
            markPaid: jest.fn(),
            refund: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminOrdersController],
            providers: [{ provide: AdminOrdersService, useValue: service }],
        })
            .overrideGuard(SuperAdminGuard)
            .useValue({ canActivate: () => true })
            .compile();

        controller = module.get<AdminOrdersController>(AdminOrdersController);
    });

    it('should be defined', () => {
        expect(controller).toBeDefined();
    });

    it('delegates every admin order action to the service', async () => {
        await controller.findAll({ page: 1, limit: 25 });
        expect(service.findAll).toHaveBeenCalledWith({ page: 1, limit: 25 });

        await controller.findOne('order-1');
        expect(service.findOne).toHaveBeenCalledWith('order-1');

        await controller.cancel('order-1');
        expect(service.cancel).toHaveBeenCalledWith('order-1');

        await controller.markPaid('order-1');
        expect(service.markPaid).toHaveBeenCalledWith('order-1');

        await controller.refund('order-1');
        expect(service.refund).toHaveBeenCalledWith('order-1');
    });
});
