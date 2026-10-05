import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { OrgMemberGuard } from '../../common/guards';

describe('MonitoringController', () => {
    let controller: MonitoringController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [MonitoringController],
            providers: [
                {
                    provide: MonitoringService,
                    useValue: {
                        getOrganizationOverview: jest.fn(),
                        getProjectOverview: jest.fn(),
                    },
                },
            ],
        })
            .overrideGuard(OrgMemberGuard)
            .useValue({ canActivate: () => true })
            .compile();

        controller = module.get<MonitoringController>(MonitoringController);
    });

    it('should be defined', () => {
        expect(controller).toBeDefined();
    });
});
