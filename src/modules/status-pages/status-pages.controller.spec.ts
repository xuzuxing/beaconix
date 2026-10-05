import { Test, TestingModule } from '@nestjs/testing';
import { StatusPagesController } from './status-pages.controller';
import { StatusPagesService } from './status-pages.service';
import { OrgMemberGuard, RolesGuard } from '../../common/guards';

describe('StatusPagesController', () => {
    let controller: StatusPagesController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [StatusPagesController],
            providers: [
                {
                    provide: StatusPagesService,
                    useValue: {
                        findAll: jest.fn(),
                        create: jest.fn(),
                        findOne: jest.fn(),
                        update: jest.fn(),
                        remove: jest.fn(),
                    },
                },
            ],
        })
            .overrideGuard(OrgMemberGuard)
            .useValue({ canActivate: () => true })
            .overrideGuard(RolesGuard)
            .useValue({ canActivate: () => true })
            .compile();

        controller = module.get<StatusPagesController>(StatusPagesController);
    });

    it('should be defined', () => {
        expect(controller).toBeDefined();
    });
});
