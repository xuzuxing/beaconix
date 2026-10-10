import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiCreatedResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuditLog, CurrentUser } from '../../../common/decorators';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { ApiCredentialsService } from './api-credentials.service';
import { CreatePersonalAccessTokenDto } from './dto';
import { PersonalAccessTokenEntity } from './entities';

@ApiTags('Personal access tokens')
@ApiBearerAuth('access-token')
@Controller('users/me/personal-access-tokens')
export class PersonalAccessTokensController {
    constructor(
        private readonly apiCredentialsService: ApiCredentialsService,
    ) {}

    @Post()
    @AuditLog({ entity: 'PersonalAccessToken', action: 'CREATE' })
    @ApiOperation({
        summary:
            'Create a personal access token (returns the JWT once). PATs carry your user permissions.',
    })
    @ApiBody({ type: CreatePersonalAccessTokenDto })
    @ApiCreatedResponse({
        type: PersonalAccessTokenEntity,
        description: 'Token created; the `token` field is shown only once',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    async create(
        @CurrentUser() user: JwtPayload,
        @Body() dto: CreatePersonalAccessTokenDto,
    ) {
        return this.apiCredentialsService.createPersonalAccessToken(user, dto);
    }

    @Get()
    @ApiOperation({
        summary: 'List personal access tokens (secrets are masked)',
    })
    @ApiOkResponse({ type: [PersonalAccessTokenEntity] })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    async findAll(@CurrentUser() user: JwtPayload) {
        return this.apiCredentialsService.listPersonalAccessTokens(user.sub);
    }

    @Post(':id/revoke')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'PersonalAccessToken', action: 'UPDATE' })
    @ApiOperation({ summary: 'Revoke a personal access token' })
    @ApiParam({ name: 'id', description: 'Token CUID' })
    @ApiOkResponse({ type: PersonalAccessTokenEntity })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiNotFoundResponse({ description: 'Token not found' })
    async revoke(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
        return this.apiCredentialsService.revokePersonalAccessToken(
            user.sub,
            id,
        );
    }
}
