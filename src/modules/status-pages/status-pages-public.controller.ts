import { Controller, Get, Param, Query, UseInterceptors } from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Public, SkipTransform } from '../../common/decorators';
import { QueryPublicStatusPageDto } from './dto';
import { PublicStatusPageEntity } from './entities';
import { PublicStatusEtagInterceptor } from './public-status-etag.interceptor';
import { StatusPagesService } from './status-pages.service';

@ApiTags('Status Pages (public)')
@Controller('status')
export class StatusPagesPublicController {
    constructor(private readonly statusPagesService: StatusPagesService) {}

    @Get(':slug')
    @Public()
    @SkipTransform()
    @UseInterceptors(PublicStatusEtagInterceptor)
    @ApiOperation({ summary: 'Read a public status page by slug' })
    @ApiParam({ name: 'slug', description: 'Status page slug' })
    @ApiQuery({
        name: 'tz',
        required: false,
        description:
            'IANA time zone the hourly availability buckets are built in',
        example: 'Asia/Shanghai',
    })
    @ApiOkResponse({
        type: PublicStatusPageEntity,
        description: 'Public status page',
    })
    @ApiBadRequestResponse({
        description:
            'Unknown, empty or repeated query parameter, or a time zone that is not an IANA name',
    })
    @ApiNotFoundResponse({ description: 'Status page not found or disabled' })
    @ApiResponse({
        status: 304,
        description: 'Unchanged snapshot; no response body',
    })
    async getPublic(
        @Param('slug') slug: string,
        @Query() query: QueryPublicStatusPageDto,
    ) {
        return this.statusPagesService.getPublicBySlug(slug, query.tz);
    }
}
