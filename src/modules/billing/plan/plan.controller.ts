import { Controller, Get, Param } from '@nestjs/common';
import {
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../common/decorators';
import { PlanEntity } from './entities';
import { PlanService } from './plan.service';

@ApiTags('Billing / Plans')
@Controller('plans')
export class PlanController {
    constructor(private readonly planService: PlanService) {}

    @Get()
    @Public()
    @ApiOperation({ summary: 'List enabled billing plans' })
    @ApiOkResponse({ type: [PlanEntity], description: 'Plan catalog' })
    async findAll(): Promise<PlanEntity[]> {
        return this.planService.findAll();
    }

    @Get(':id')
    @Public()
    @ApiOperation({ summary: 'Get a billing plan by ID' })
    @ApiParam({ name: 'id', description: 'Plan UUID' })
    @ApiOkResponse({ type: PlanEntity, description: 'Plan details' })
    @ApiNotFoundResponse({ description: 'Plan not found' })
    async findOne(@Param('id') id: string): Promise<PlanEntity> {
        return this.planService.findOne(id);
    }
}
