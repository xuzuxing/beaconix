import { Controller, Get, Param } from '@nestjs/common';
import {
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { PublicStatusPageEntity } from './entities';
import { StatusPagesService } from './status-pages.service';

@ApiTags('Status Pages (public)')
@Controller('status')
export class StatusPagesPublicController {
    constructor(private readonly statusPagesService: StatusPagesService) {}

    @Get(':slug')
    @Public()
    @ApiOperation({ summary: 'Read a public status page by slug' })
    @ApiParam({ name: 'slug', description: 'Status page slug' })
    @ApiOkResponse({
        type: PublicStatusPageEntity,
        description: 'Public status page',
    })
    @ApiNotFoundResponse({ description: 'Status page not found or disabled' })
    async getPublic(@Param('slug') slug: string) {
        return this.statusPagesService.getPublicBySlug(slug);
    }
}
