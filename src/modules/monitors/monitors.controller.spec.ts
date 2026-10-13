import { Test, TestingModule } from '@nestjs/testing';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';
import { OrgMemberGuard, RolesGuard } from '../../common/guards';
import { ResourceContextResolver } from '../../common/authorization/resource-context.resolver';
import { ProjectAccessService } from '../../common/authorization/project-access.service';

describe('MonitorsController', () => {
    let controller: MonitorsController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [MonitorsController],
            providers: [
                { provide: ResourceContextResolver, useValue: {} },
                { provide: ProjectAccessService, useValue: {} },
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
