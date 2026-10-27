import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    ArrayUnique,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { MonitorType } from '../../../../generated/prisma/enums';
import { CreatePlanTermDto } from './plan-term.dto';

/** Every monitor protocol a plan may allow. */
export const PLAN_MONITOR_TYPES: MonitorType[] = Object.values(MonitorType);

/** Plan codes are stored upper-cased: one letter, then 1–31 of `A-Z0-9_`. */
export const PLAN_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

/** Normalizes a plan code to its stored form (trimmed, upper-cased). */
export function normalizePlanCode(code: string): string {
    return code.trim().toUpperCase();
}

const toCode = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizePlanCode(value) : value;

/**
 * Full plan definition for the admin catalog.
 *
 * Quota semantics used by the runtime (see `QuotaService`):
 * - `maxMonitors` / `maxProbes` / `maxMembers` / `maxChannels` / `maxApiKeys`
 *   of `0` means the resource is **not available** on the plan (the usage check
 *   is `used >= limit`), not "unlimited".
 * - `allowedMonitorTypes` is matched with `includes()`, so an empty array means
 *   **no** monitor protocol may be created on the plan.
 */
export class CreatePlanDto {
    @ApiProperty({
        example: 'PRO',
        description:
            'Upper-case plan code (`^[A-Z][A-Z0-9_]{1,31}$`). Trimmed and upper-cased before validation. Immutable once created.',
    })
    @Transform(toCode)
    @IsString()
    @Matches(PLAN_CODE_PATTERN, {
        message: 'code must match ^[A-Z][A-Z0-9_]{1,31}$',
    })
    code: string;

    @ApiProperty({ example: '专业版', maxLength: 60 })
    @IsString()
    @MinLength(1)
    @MaxLength(60)
    name: string;

    @ApiPropertyOptional({
        example: 'For small teams',
        maxLength: 300,
        nullable: true,
        type: String,
    })
    @IsOptional()
    @IsString()
    @MaxLength(300)
    description?: string | null;

    @ApiProperty({
        type: [CreatePlanTermDto],
        description:
            'Purchasable cycles, each with its own price. At least one enabled term is required; the cheapest enabled term becomes the plan price shown in the public catalog. On PATCH the whole set is replaced — a cycle that disappears is disabled (or deleted when no order references it).',
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(3)
    @ValidateNested({ each: true })
    @Type(() => CreatePlanTermDto)
    @ArrayUnique((term: CreatePlanTermDto) => term.cycle, {
        message: 'each cycle may only appear once',
    })
    terms: CreatePlanTermDto[];

    @ApiPropertyOptional({ example: 0, default: 0, minimum: 0 })
    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number;

    @ApiPropertyOptional({
        example: 50,
        minimum: 0,
        description: '0 means the plan cannot create any monitor',
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    maxMonitors?: number;

    @ApiPropertyOptional({
        example: 3,
        minimum: 0,
        description: '0 means the plan cannot own any probe',
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    maxProbes?: number;

    @ApiPropertyOptional({
        example: 0,
        minimum: 0,
        description:
            'System probes auto-assigned to each monitor, picked from the online system probe pool. 0 disables the pool. Tenant probe binding is bounded by maxProbes only.',
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    maxProbesPerMonitor?: number;

    @ApiPropertyOptional({
        example: 5,
        minimum: 0,
        description: '0 means the plan cannot create any API key',
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    maxApiKeys?: number;

    @ApiPropertyOptional({
        example: 10,
        minimum: 0,
        description: '0 means the plan cannot invite any member',
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    maxMembers?: number;

    @ApiPropertyOptional({
        example: 5,
        minimum: 0,
        description: '0 means the plan cannot create any notification channel',
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    maxChannels?: number;

    @ApiPropertyOptional({
        example: 60,
        minimum: 10,
        maximum: 86400,
        description: 'Fastest check interval allowed, in seconds',
    })
    @IsOptional()
    @IsInt()
    @Min(10)
    @Max(86400)
    minInterval?: number;

    @ApiPropertyOptional({ example: true, default: false })
    @IsOptional()
    @IsBoolean()
    allowTenantProbe?: boolean;

    @ApiPropertyOptional({ example: true, default: false })
    @IsOptional()
    @IsBoolean()
    allowStatusPage?: boolean;

    @ApiPropertyOptional({
        enum: MonitorType,
        isArray: true,
        description:
            'Monitor protocols allowed by the plan. An empty array blocks every protocol.',
    })
    @IsOptional()
    @IsArray()
    @IsIn(PLAN_MONITOR_TYPES, { each: true })
    allowedMonitorTypes?: MonitorType[];

    @ApiPropertyOptional({ example: true, default: true })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}
