import { Test, TestingModule } from '@nestjs/testing';
import { StatusPagesPublicController } from './status-pages-public.controller';
import { StatusPagesService } from './status-pages.service';

describe('StatusPagesPublicController', () => {
    let controller: StatusPagesPublicController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [StatusPagesPublicController],
            providers: [
                {
                    provide: StatusPagesService,
                    useValue: { getPublicBySlug: jest.fn() },
                },
            ],
        }).compile();

        controller = module.get<StatusPagesPublicController>(
            StatusPagesPublicController,
        );
    });

    it('should be defined', () => {
        expect(controller).toBeDefined();
    });
});
