import { Test, TestingModule } from '@nestjs/testing';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';
import { OrgMemberGuard, RolesGuard } from '../../common/guards';

describe('MonitorsController', () => {
    let controller: MonitorsController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [MonitorsController],
            providers: [
                {
                    provide: MonitorsService,
                    useValue: {
                        findAll: jest.fn(),
                        create: jest.fn(),
                        findOne: jest.fn(),
                        update: jest.fn(),
                        pause: jest.fn(),
                        resume: jest.fn(),
                        softDelete: jest.fn(),
                        restore: jest.fn(),
                    },
                },
            ],
        })
            .overrideGuard(OrgMemberGuard)
            .useValue({ canActivate: () => true })
            .overrideGuard(RolesGuard)
            .useValue({ canActivate: () => true })
            .compile();

        controller = module.get<MonitorsController>(MonitorsController);
    });

    it('should be defined', () => {
        expect(controller).toBeDefined();
    });
});
