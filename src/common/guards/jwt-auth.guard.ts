import {
    Injectable,
    CanActivate,
    ExecutionContext,
    UnauthorizedException,
    ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { PrismaService } from '../../infra/database/prisma.service';

type AccessPayload = JwtPayload & {
    kind?: string;
    patId?: string;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(
        private readonly jwtService: JwtService,
        private readonly reflector: Reflector,
        private readonly prisma: PrismaService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean>(
            IS_PUBLIC_KEY,
            [context.getHandler(), context.getClass()],
        );
        if (isPublic) return true;

        const request = context.switchToHttp().getRequest<Request>();
        const token = this.extractBearerToken(request);
        if (!token) {
            throw new UnauthorizedException('Missing access token');
        }

        try {
            const payload =
                await this.jwtService.verifyAsync<AccessPayload>(token);

            if (payload.kind === 'pat') {
                throw new ForbiddenException(
                    'Personal access tokens are only accepted on the developer API',
                );
            }
            if (
                !payload.sub ||
                (payload.kind !== undefined && payload.kind !== 'pat')
            ) {
                throw new UnauthorizedException(
                    'Invalid access token identity',
                );
            }
            const current = await this.prisma.user.findFirst({
                where: { id: payload.sub, isActive: true, deletedAt: null },
                select: { id: true, email: true, globalRole: true },
            });
            if (!current)
                throw new UnauthorizedException('User is no longer active');
            request['user'] = {
                sub: current.id,
                email: current.email,
                globalRole: current.globalRole,
                iat: payload.iat,
                exp: payload.exp,
            };
            request['accessPrincipal'] = { type: 'USER', userId: current.id };
        } catch (error) {
            if (
                error instanceof UnauthorizedException ||
                error instanceof ForbiddenException
            )
                throw error;
            throw new UnauthorizedException('Invalid or expired access token');
        }

        return true;
    }

    private extractBearerToken(request: Request): string | null {
        const [type, token] = request.headers.authorization?.split(' ') ?? [];
        return type === 'Bearer' ? token : null;
    }
}
