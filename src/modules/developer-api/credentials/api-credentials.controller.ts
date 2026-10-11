import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiCreatedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuditLog, CurrentUser, Roles } from '../../../common/decorators';
import { OrgMemberGuard, RolesGuard } from '../../../common/guards';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { ApiCredentialsService } from './api-credentials.service';
import { CreateApiKeyDto } from './dto';
import { ApiKeyEntity } from './entities';

@ApiTags('Developer API keys')
@ApiBearerAuth('access-token')
@Controller('organizations/:orgId/api-keys')
export class ApiCredentialsController {
    constructor(
        private readonly apiCredentialsService: ApiCredentialsService,
    ) {}

    @Post()
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'ApiKey', action: 'CREATE' })
    @ApiOperation({
        summary: 'Create an organization API key (returns the secret once)',
    })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiBody({ type: CreateApiKeyDto })
    @ApiCreatedResponse({
        type: ApiKeyEntity,
        description: 'API key created; the `key` field is shown only once',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    async create(
        @Param('orgId') orgId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: CreateApiKeyDto,
    ) {
        return this.apiCredentialsService.createApiKey(orgId, user.sub, dto);
    }

    @Get()
    @UseGuards(OrgMemberGuard)
    @ApiOperation({
        summary: 'List organization API keys (secrets are masked)',
    })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiOkResponse({ type: [ApiKeyEntity], description: 'API keys' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Not a member' })
    async findAll(@Param('orgId') orgId: string) {
        return this.apiCredentialsService.listApiKeys(orgId);
    }

    @Post(':id/revoke')
    @HttpCode(HttpStatus.OK)
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'ApiKey', action: 'UPDATE' })
    @ApiOperation({ summary: 'Revoke an organization API key' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'API key CUID' })
    @ApiOkResponse({ type: ApiKeyEntity, description: 'Revoked API key' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'API key not found' })
    async revoke(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.apiCredentialsService.revokeApiKey(orgId, id, user.sub);
    }
}
