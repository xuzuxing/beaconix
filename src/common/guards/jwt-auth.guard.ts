import {
    Injectable,
    CanActivate,
    ExecutionContext,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { PrismaService } from '../../infra/database/prisma.service';

type AccessPayload = JwtPayload & {
    kind?: 'pat';
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

            // PATs are revocable: reject revoked/expired tokens even when the
            // JWT signature itself is still valid.
            if (payload.kind === 'pat') {
                if (!payload.patId) {
                    throw new UnauthorizedException(
                        'Invalid personal access token',
                    );
                }
                const pat = await this.prisma.personalAccessToken.findUnique({
                    where: { id: payload.patId },
                    select: { revokedAt: true, expiresAt: true },
                });
                if (!pat || pat.revokedAt) {
                    throw new UnauthorizedException(
                        'Personal access token revoked',
                    );
                }
                if (pat.expiresAt && pat.expiresAt <= new Date()) {
                    throw new UnauthorizedException(
                        'Personal access token expired',
                    );
                }
                void this.prisma.personalAccessToken
                    .update({
                        where: { id: payload.patId },
                        data: { lastUsedAt: new Date() },
                    })
                    .catch(() => undefined);
            }

            request['user'] = payload;
        } catch (error) {
            if (error instanceof UnauthorizedException) throw error;
            throw new UnauthorizedException('Invalid or expired access token');
        }

        return true;
    }

    private extractBearerToken(request: Request): string | null {
        const [type, token] = request.headers.authorization?.split(' ') ?? [];
        return type === 'Bearer' ? token : null;
    }
}
