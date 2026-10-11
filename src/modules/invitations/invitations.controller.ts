import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    HttpCode,
    HttpStatus,
    UseGuards,
} from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiBody,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiBadRequestResponse,
    ApiUnauthorizedResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiConflictResponse,
} from '@nestjs/swagger';
import { InvitationsService } from './invitations.service';
import { CreateInvitationDto } from './dto';
import { InvitationEntity } from './entities';
import { CurrentUser, Public, Roles, AuditLog } from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';

@ApiTags('Invitations')
@Controller()
export class InvitationsController {
    constructor(private readonly invitationsService: InvitationsService) {}

    // ── Org-scoped endpoints (ADMIN required) ──────────────────────────

    @Post('organizations/:orgId/invitations')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @AuditLog({ entity: 'Invitation', action: 'INVITE' })
    @ApiBearerAuth('access-token')
    @ApiOperation({ summary: 'Send an invitation to join the organization' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiBody({ type: CreateInvitationDto })
    @ApiCreatedResponse({
        type: InvitationEntity,
        description: 'Invitation sent',
    })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Organization not found' })
    @ApiConflictResponse({
        description:
            'Pending invitation already exists or user is already a member',
    })
    async send(
        @Param('orgId') orgId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: CreateInvitationDto,
    ) {
        return this.invitationsService.send(orgId, user.sub, dto);
    }

    @Get('organizations/:orgId/invitations')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @ApiBearerAuth('access-token')
    @ApiOperation({ summary: 'List all invitations for an organization' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiOkResponse({
        type: [InvitationEntity],
        description: 'List of invitations',
    })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    async findAll(@Param('orgId') orgId: string) {
        return this.invitationsService.findAllForOrg(orgId);
    }

    @Delete('organizations/:orgId/invitations/:id')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Invitation', action: 'DELETE' })
    @ApiBearerAuth('access-token')
    @ApiOperation({ summary: 'Revoke a pending invitation' })
    @ApiParam({ name: 'orgId', description: 'Organization CUID' })
    @ApiParam({ name: 'id', description: 'Invitation CUID' })
    @ApiOkResponse({
        type: InvitationEntity,
        description: 'Invitation revoked',
    })
    @ApiBadRequestResponse({ description: 'Invitation is not pending' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiForbiddenResponse({ description: 'Insufficient role (requires ADMIN)' })
    @ApiNotFoundResponse({ description: 'Invitation not found' })
    async revoke(
        @Param('orgId') orgId: string,
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.invitationsService.revoke(orgId, id, user.sub);
    }

    // ── Token-based endpoints (public / JWT) ───────────────────────────

    @Get('invitations/pending')
    @ApiBearerAuth('access-token')
    @ApiOperation({
        summary: 'List pending invitations for the verified current email',
    })
    @ApiOkResponse({ type: [InvitationEntity] })
    @ApiUnauthorizedResponse({ description: 'Authentication required' })
    @ApiForbiddenResponse({ description: 'Verified email required' })
    async pending(@CurrentUser() user: JwtPayload) {
        return this.invitationsService.findPendingForUser(user.sub);
    }

    @Get('invitations/by-id/:id')
    @ApiBearerAuth('access-token')
    @ApiOperation({
        summary: 'Get an invitation addressed to the verified current email',
    })
    @ApiParam({ name: 'id', description: 'Invitation CUID' })
    @ApiOkResponse({ type: InvitationEntity })
    @ApiUnauthorizedResponse({ description: 'Authentication required' })
    @ApiForbiddenResponse({
        description: 'Invitation belongs to another email',
    })
    @ApiNotFoundResponse({ description: 'Invitation not found' })
    async byId(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
        return this.invitationsService.getById(id, user.sub);
    }

    @Post('invitations/by-id/:id/accept')
    @HttpCode(HttpStatus.OK)
    @AuditLog({ entity: 'Invitation', action: 'JOIN' })
    @ApiBearerAuth('access-token')
    @ApiOperation({
        summary: 'Accept an invitation addressed to the verified current email',
    })
    @ApiParam({ name: 'id', description: 'Invitation CUID' })
    @ApiOkResponse({ type: InvitationEntity })
    @ApiBadRequestResponse({
        description: 'Invitation expired or no longer pending',
    })
    @ApiUnauthorizedResponse({ description: 'Authentication required' })
    @ApiForbiddenResponse({ description: 'Verified matching email required' })
    @ApiNotFoundResponse({ description: 'Invitation not found' })
    @ApiConflictResponse({
        description: 'Invitation already processed or user already a member',
    })
    async acceptById(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
        return this.invitationsService.acceptById(id, user.sub);
    }

    @Post('invitations/by-id/:id/decline')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('access-token')
    @ApiOperation({
        summary:
            'Decline an invitation addressed to the verified current email',
    })
    @ApiParam({ name: 'id', description: 'Invitation CUID' })
    @ApiOkResponse({ type: InvitationEntity })
    @ApiBadRequestResponse({
        description: 'Invitation expired or no longer pending',
    })
    @ApiUnauthorizedResponse({ description: 'Authentication required' })
    @ApiForbiddenResponse({ description: 'Verified matching email required' })
    @ApiNotFoundResponse({ description: 'Invitation not found' })
    @ApiConflictResponse({ description: 'Invitation already processed' })
    async declineById(
        @Param('id') id: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.invitationsService.declineById(id, user.sub);
    }

    @Get('invitations/:token')
    @Public()
    @ApiOperation({
        summary: 'Get invitation info by token (public)',
        description:
            'Used by the invitee to view invitation details before accepting/declining.',
    })
    @ApiParam({ name: 'token', description: 'Invitation token (CUID)' })
    @ApiOkResponse({
        type: InvitationEntity,
        description: 'Invitation details',
    })
    @ApiNotFoundResponse({ description: 'Invitation not found' })
    async getByToken(@Param('token') token: string) {
        return this.invitationsService.getByToken(token);
    }

    @Post('invitations/:token/accept')
    @AuditLog({ entity: 'Invitation', action: 'JOIN', idParam: 'token' })
    @ApiBearerAuth('access-token')
    @ApiOperation({
        summary: 'Accept an invitation',
        description:
            'Authenticated user accepts the invitation and becomes an org member.',
    })
    @ApiParam({ name: 'token', description: 'Invitation token (CUID)' })
    @ApiOkResponse({
        type: InvitationEntity,
        description: 'Invitation accepted — membership created',
    })
    @ApiBadRequestResponse({ description: 'Invitation expired or not pending' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiNotFoundResponse({ description: 'Invitation not found' })
    @ApiConflictResponse({
        description: 'Already a member of this organization',
    })
    async accept(
        @Param('token') token: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.invitationsService.accept(token, user.sub);
    }

    @Post('invitations/:token/decline')
    @ApiBearerAuth('access-token')
    @ApiOperation({ summary: 'Decline an invitation' })
    @ApiParam({ name: 'token', description: 'Invitation token (CUID)' })
    @ApiOkResponse({
        type: InvitationEntity,
        description: 'Invitation declined',
    })
    @ApiBadRequestResponse({ description: 'Invitation is not pending' })
    @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT' })
    @ApiNotFoundResponse({ description: 'Invitation not found' })
    async decline(
        @Param('token') token: string,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.invitationsService.decline(token, user.sub);
    }
}
