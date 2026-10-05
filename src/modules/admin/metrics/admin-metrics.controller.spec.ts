import { Test, TestingModule } from '@nestjs/testing';
import { SuperAdminGuard } from '../../../common/guards';
import { AdminMetricsController } from './admin-metrics.controller';
import { AdminMetricsService } from './admin-metrics.service';

describe('AdminMetricsController', () => {
    let controller: AdminMetricsController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminMetricsController],
            providers: [
                {
                    provide: AdminMetricsService,
                    useValue: {
                        getOverview: jest.fn(),
                        getTenantMetrics: jest.fn(),
                    },
                },
            ],
        })
            .overrideGuard(SuperAdminGuard)
            .useValue({ canActivate: () => true })
            .compile();

        controller = module.get<AdminMetricsController>(AdminMetricsController);
    });

    it('should be defined', () => {
        expect(controller).toBeDefined();
    });
});
