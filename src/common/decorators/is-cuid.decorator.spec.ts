import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata, Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { QueryAuditLogsDto } from '../../modules/audit-logs/dto/query-audit-logs.dto';
import { QueryAdminAuditLogsDto } from '../../modules/admin/audit-logs/dto/query-admin-audit-logs.dto';
import { CreateOrderDto } from '../../modules/billing/order/dto/create-order.dto';
import { CreateCommentDto } from '../../modules/comments/dto/create-comment.dto';
import { TransferOwnershipDto } from '../../modules/organizations/dto/transfer-ownership.dto';
import { AddDependencyDto } from '../../modules/tasks/dto/add-dependency.dto';
import { AssignTaskDto } from '../../modules/tasks/dto/assign-task.dto';
import { CreateTaskDto } from '../../modules/tasks/dto/create-task.dto';
import { MoveTaskToSprintDto } from '../../modules/tasks/dto/move-task-to-sprint.dto';
import { QueryTasksDto } from '../../modules/tasks/dto/query-tasks.dto';
import { UpdateTaskDto } from '../../modules/tasks/dto/update-task.dto';
import { IsCuid } from './is-cuid.decorator';

const CUID = 'cmgu92m5x0000p8l4h8z6s3k1';
const UUID = '550e8400-e29b-41d4-a716-446655440000';

interface DtoCase {
    dto: Type<object>;
    fields: string[];
    base?: Record<string, unknown>;
    source?: ArgumentMetadata['type'];
    required?: boolean;
}

const dtoCases: DtoCase[] = [
    {
        dto: CreateTaskDto,
        fields: ['sprintId', 'parentTaskId', 'assignedToId'],
        base: { title: 'A task' },
    },
    { dto: UpdateTaskDto, fields: ['parentTaskId'] },
    {
        dto: QueryTasksDto,
        fields: ['assignedToId', 'sprintId', 'parentTaskId'],
        source: 'query',
    },
    {
        dto: AddDependencyDto,
        fields: ['dependencyTaskId'],
        required: true,
    },
    { dto: AssignTaskDto, fields: ['assignedToId'] },
    { dto: MoveTaskToSprintDto, fields: ['sprintId'] },
    {
        dto: CreateCommentDto,
        fields: ['parentId'],
        base: { body: 'A comment' },
    },
    {
        dto: TransferOwnershipDto,
        fields: ['newOwnerId'],
        required: true,
    },
    {
        // 租户侧查询没有 organizationId：租户恒取路径参数，查询串不能扩大范围。
        dto: QueryAuditLogsDto,
        fields: ['actorId', 'projectId', 'entityId'],
        source: 'query',
    },
    {
        // 跨租户查询只对 SUPER_ADMIN 开放，organizationId 在这里是合法过滤条件。
        dto: QueryAdminAuditLogsDto,
        fields: ['organizationId'],
        source: 'query',
    },
    { dto: CreateOrderDto, fields: ['planId'], required: true },
];

const fieldCases = dtoCases.flatMap(({ fields, ...dtoCase }) =>
    fields.map((field) => ({
        ...dtoCase,
        field,
        name: `${dtoCase.dto.name}.${field}`,
    })),
);

describe('CUID request validation', () => {
    const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
    });

    describe.each(fieldCases)(
        '$name',
        ({ dto, field, base = {}, source = 'body', required }) => {
            const metadata: ArgumentMetadata = { type: source, metatype: dto };

            it.each([CUID, `c${'a'.repeat(29)}`])(
                'accepts CUID %s through the request pipe',
                async (id) => {
                    const result: unknown = await pipe.transform(
                        { ...base, [field]: id },
                        metadata,
                    );

                    expect(result).toBeInstanceOf(dto);
                    expect(result).toMatchObject({ [field]: id });
                },
            );

            it.each([
                UUID,
                '',
                'not-an-id',
                `c${'a'.repeat(23)}`,
                `c${'a'.repeat(30)}`,
                CUID.toUpperCase(),
                `x${CUID.slice(1)}`,
                `${CUID.slice(0, -1)}-`,
                ` ${CUID}`,
                `${CUID} `,
                `${CUID}\n`,
                123,
                [CUID],
                { id: CUID },
            ])('rejects invalid ID %j', async (id) => {
                await expect(
                    pipe.transform({ ...base, [field]: id }, metadata),
                ).rejects.toThrow(BadRequestException);
            });

            it.each([undefined, null])(
                required ? 'rejects required ID %j' : 'allows optional ID %j',
                async (id) => {
                    const payload =
                        id === undefined ? base : { ...base, [field]: id };
                    const result = pipe.transform(payload, metadata);

                    if (required) {
                        await expect(result).rejects.toThrow(
                            BadRequestException,
                        );
                    } else {
                        await expect(result).resolves.toBeInstanceOf(dto);
                    }
                },
            );
        },
    );
});

describe('IsCuid', () => {
    class CuidDto {
        @IsCuid()
        id: string;
    }

    class CuidListDto {
        @IsCuid({ each: true, message: 'Every ID must be a CUID' })
        ids: string[];
    }

    it('reports the field name and CUID format in validation errors', () => {
        const errors = validateSync(plainToInstance(CuidDto, { id: UUID }));

        expect(errors).toHaveLength(1);
        expect(Object.values(errors[0].constraints ?? {})).toContain(
            'id must be a CUID',
        );
    });

    it('supports each and custom validation messages', () => {
        expect(
            validateSync(plainToInstance(CuidListDto, { ids: [CUID] })),
        ).toEqual([]);

        const errors = validateSync(
            plainToInstance(CuidListDto, { ids: [CUID, UUID] }),
        );

        expect(errors).toHaveLength(1);
        expect(Object.values(errors[0].constraints ?? {})).toContain(
            'Every ID must be a CUID',
        );
    });
});
