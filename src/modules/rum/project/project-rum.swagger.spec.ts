import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ProjectAccessGuard } from '../../../common/authorization/project-access.guard';
import { ProjectRumController } from './project-rum.controller';
import { ProjectRumService } from './project-rum.service';

describe('project RUM API documentation', () => {
    it('documents scoped endpoints, filters, pagination, and response schemas', async () => {
        const module = await Test.createTestingModule({
            controllers: [ProjectRumController],
            providers: [{ provide: ProjectRumService, useValue: {} }],
        })
            .overrideGuard(ProjectAccessGuard)
            .useValue({ canActivate: () => true })
            .compile();
        const app = module.createNestApplication();
        app.setGlobalPrefix('api');
        await app.init();
        try {
            const document = SwaggerModule.createDocument(
                app,
                new DocumentBuilder().setTitle('test').build(),
            );
            const errors =
                document.paths['/api/projects/{projectId}/rum/errors']?.get;
            const events =
                document.paths['/api/projects/{projectId}/rum/events']?.get;
            expect(
                document.paths['/api/projects/{projectId}/rum/overview']?.get,
            ).toBeDefined();
            expect(errors?.parameters).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: 'appId', in: 'query' }),
                    expect.objectContaining({ name: 'type', in: 'query' }),
                    expect.objectContaining({ name: 'page', in: 'query' }),
                    expect.objectContaining({ name: 'from', in: 'query' }),
                    expect.objectContaining({ name: 'to', in: 'query' }),
                ]),
            );
            expect(events?.parameters).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: 'appId', in: 'query' }),
                    expect.objectContaining({ name: 'eventName', in: 'query' }),
                    expect.objectContaining({ name: 'page', in: 'query' }),
                ]),
            );
            expect(errors?.responses?.['200']).toBeDefined();
            expect(events?.responses?.['200']).toBeDefined();
        } finally {
            await app.close();
        }
    });
});
