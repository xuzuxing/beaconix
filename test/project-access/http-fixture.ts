import 'reflect-metadata';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, type Type } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { METHOD_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../src/infra/database/prisma.service';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { OrgMemberGuard } from '../../src/common/guards/org-member.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { ProjectAccessGuard } from '../../src/common/authorization/project-access.guard';
import { ResourceContextResolver } from '../../src/common/authorization/resource-context.resolver';
import { ProjectAccessService } from '../../src/common/authorization/project-access.service';
import { TransformInterceptor } from '../../src/common/interceptors/transform.interceptor';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { TasksController } from '../../src/modules/tasks/tasks.controller';
import { TasksService } from '../../src/modules/tasks/tasks.service';
import { QueryTasksDto } from '../../src/modules/tasks/dto/query-tasks.dto';
import { CommentsController } from '../../src/modules/comments/comments.controller';
import { CommentsService } from '../../src/modules/comments/comments.service';
import { SprintsController } from '../../src/modules/sprints/sprints.controller';
import { SprintsService } from '../../src/modules/sprints/sprints.service';
import {
    LabelsController,
    OrgLabelsController,
    ProjectLabelsController,
    TaskLabelsController,
} from '../../src/modules/labels/labels.controller';
import { LabelsService } from '../../src/modules/labels/labels.service';
import { AttachmentsController } from '../../src/modules/attachments/attachments.controller';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import {
    OrganizationProjectPermissionsController,
    ProjectPermissionsController,
} from '../../src/modules/memberships/project-permissions.controller';
import { ProjectPermissionsService } from '../../src/modules/memberships/project-permissions.service';
import { DeveloperMonitorsController } from '../../src/modules/developer-api/v1/developer-monitors.controller';
import { DeveloperAuthGuard } from '../../src/modules/developer-api/auth/developer-auth.guard';
import { ApiCredentialsService } from '../../src/modules/developer-api/credentials/api-credentials.service';
import { MonitorsService } from '../../src/modules/monitors/monitors.service';
import { MonitorSecretsService } from '../../src/modules/monitors/monitor-secrets.service';
import type { SystemProbeScheduler } from '../../src/modules/admin/system-probes/system-probe-scheduler';
import type { NotifierService } from '../../src/modules/notifier/notifier.service';
import { EffectivePlanService } from '../../src/shared/subscription/effective-plan.service';
import { QuotaService } from '../../src/shared/quota/quota.service';
import { businessServices } from './fixtures';
import { explicitConnectionString, type connectPrisma } from './harness';
import type { ValidatedProjectAccessDatabase } from './database-safety';

// tsx does not emit design:paramtypes. Recover constructor injection explicitly
// and DTO argument types from the real @ApiBody + @Body metadata. This changes
// no route/policy/guard implementation and keeps the real ValidationPipe active.
export function controllerMetadata(
    controller: Type,
    service: Type,
    queryTypes: Readonly<Record<string, Type>> = {},
) {
    if (!Reflect.hasOwnMetadata('design:paramtypes', controller)) {
        Reflect.defineMetadata('design:paramtypes', [service], controller);
    }
    for (const key of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[key];
        if (
            typeof handler !== 'function' ||
            Reflect.getMetadata(METHOD_METADATA, handler) === undefined ||
            Reflect.hasOwnMetadata(
                'design:paramtypes',
                controller.prototype,
                key,
            )
        )
            continue;
        const args =
            Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, key) ?? {};
        const parameters =
            Reflect.getMetadata('swagger/apiParameters', handler) ?? [];
        const body = parameters.find(
            (parameter: { in?: string; type?: Type }) =>
                parameter.in === 'body' && typeof parameter.type === 'function',
        );
        const types = Array.from(
            { length: handler.length },
            () => Object as Type,
        );
        for (const [argument, metadata] of Object.entries(args)) {
            const kind = Number(argument.split(':')[0]);
            const index = (metadata as { index: number }).index;
            if (kind === RouteParamtypes.PARAM) types[index] = String;
            if (kind === RouteParamtypes.BODY && body) types[index] = body.type;
            if (kind === RouteParamtypes.QUERY && queryTypes[key])
                types[index] = queryTypes[key];
        }
        Reflect.defineMetadata(
            'design:paramtypes',
            types,
            controller.prototype,
            key,
        );
    }
}

export async function createHttpModule(
    prisma: PrismaService,
    database: ValidatedProjectAccessDatabase,
) {
    const services = businessServices(prisma);
    const reflector = new Reflector();
    const jwt = new JwtService({
        secret: 'project-access-disposable-http-test-secret',
    });
    const config = new ConfigService({
        database: { url: explicitConnectionString(database) },
        app: { isDevelopment: false },
        monitor: { secretKey: Buffer.alloc(32, 7).toString('base64') },
    });
    const quota = new QuotaService(prisma, new EffectivePlanService(prisma));
    const monitors = new MonitorsService(
        prisma,
        { rebalance: async () => {} } as unknown as SystemProbeScheduler,
        quota,
        {} as NotifierService,
        new MonitorSecretsService(config),
        services.access,
    );
    const credentials = new ApiCredentialsService(
        prisma,
        jwt,
        quota,
        services.notifications,
    );
    const controllers: [Type, Type][] = [
        [TasksController, TasksService],
        [CommentsController, CommentsService],
        [SprintsController, SprintsService],
        [AttachmentsController, AttachmentsService],
        [LabelsController, LabelsService],
        [OrgLabelsController, LabelsService],
        [ProjectLabelsController, LabelsService],
        [TaskLabelsController, LabelsService],
        [OrganizationProjectPermissionsController, ProjectPermissionsService],
        [ProjectPermissionsController, ProjectPermissionsService],
        [DeveloperMonitorsController, MonitorsService],
    ];
    for (const [controller, service] of controllers) {
        controllerMetadata(
            controller,
            service,
            controller === TasksController ? { findAll: QueryTasksDto } : {},
        );
    }
    // Nest registers @UseGuards enhancers separately from ordinary providers.
    // Wire those genuine instances too when esbuild omits constructor types.
    for (const [guard, dependencies] of [
        [
            ProjectAccessGuard,
            [Reflector, ResourceContextResolver, ProjectAccessService],
        ],
        [OrgMemberGuard, [PrismaService]],
        [RolesGuard, [Reflector, PrismaService]],
        [
            DeveloperAuthGuard,
            [
                Reflector,
                ApiCredentialsService,
                PrismaService,
                JwtService,
                ProjectAccessService,
            ],
        ],
    ] as [Type, Type[]][]) {
        Reflect.defineMetadata('design:paramtypes', dependencies, guard);
    }
    const resolver = new ResourceContextResolver(prisma);
    const moduleRef = await Test.createTestingModule({
        controllers: controllers.map(([controller]) => controller),
        providers: [
            { provide: ConfigService, useValue: config },
            { provide: PrismaService, useValue: prisma },
            { provide: Reflector, useValue: reflector },
            { provide: JwtService, useValue: jwt },
            { provide: ApiCredentialsService, useValue: credentials },
            { provide: ProjectAccessService, useValue: services.access },
            { provide: ResourceContextResolver, useValue: resolver },
            {
                provide: ProjectAccessGuard,
                useValue: new ProjectAccessGuard(
                    reflector,
                    resolver,
                    services.access,
                ),
            },
            { provide: OrgMemberGuard, useValue: new OrgMemberGuard(prisma) },
            {
                provide: RolesGuard,
                useValue: new RolesGuard(reflector, prisma),
            },
            {
                provide: DeveloperAuthGuard,
                useValue: new DeveloperAuthGuard(
                    reflector,
                    credentials,
                    prisma,
                    jwt,
                    services.access,
                ),
            },
            {
                provide: APP_GUARD,
                useValue: new JwtAuthGuard(jwt, reflector, prisma),
            },
            { provide: TasksService, useValue: services.tasks },
            { provide: CommentsService, useValue: services.comments },
            { provide: SprintsService, useValue: services.sprints },
            { provide: LabelsService, useValue: services.labels },
            { provide: AttachmentsService, useValue: services.attachments },
            {
                provide: ProjectPermissionsService,
                useValue: services.permissions,
            },
            { provide: MonitorsService, useValue: monitors },
        ],
    }).compile();
    return { moduleRef, services, jwt };
}

export async function createHttpFixture(
    handle: Awaited<ReturnType<typeof connectPrisma>>,
    database: ValidatedProjectAccessDatabase,
) {
    const prisma = handle.prisma;
    const { moduleRef, services, jwt } = await createHttpModule(
        prisma,
        database,
    );
    const app = moduleRef.createNestApplication({ logger: false });
    try {
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
            }),
        );
        app.useGlobalInterceptors(new TransformInterceptor());
        app.useGlobalFilters(new GlobalExceptionFilter());
        await app.init();
        const identity = await moduleRef.get(PrismaService).$queryRaw<
            { database: string }[]
        >`
            SELECT current_database() AS database
        `;
        assert.equal(identity[0]?.database, database.database);
        for (const token of [
            TasksService,
            CommentsService,
            SprintsService,
            LabelsService,
            AttachmentsService,
            ProjectPermissionsService,
            MonitorsService,
        ]) {
            assert.equal(Reflect.get(moduleRef.get(token), 'prisma'), prisma);
        }
        assert.equal(moduleRef.get(PrismaService), prisma);
        assert.equal(
            Reflect.get(moduleRef.get(ProjectAccessService), 'prisma'),
            prisma,
        );
        return { app, jwt, services, moduleRef };
    } catch (error) {
        await app.close().catch(() => undefined);
        throw error;
    }
}
