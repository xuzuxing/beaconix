import { Module } from '@nestjs/common';
import { ClsModule as NestClsModule, ClsService } from 'nestjs-cls';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { createRequestIdClsMiddleware } from './request-id.cls';
import { PrismaModule } from '../database/prisma.module';
import { PrismaService } from '../database/prisma.service';

/**
 * CLS (Continuation-Local Storage) 模块
 * 提供请求级别的上下文存储，用于：
 * 1. Request ID 追踪 - 每个请求都有唯一标识
 * 2. 用户信息传递 - 在请求生命周期内共享用户信息
 * 3. 事务上下文 - 通过 @nestjs-cls/transactional 自动管理事务
 */
@Module({
    imports: [
        NestClsModule.forRoot({
            global: true,
            middleware: createRequestIdClsMiddleware(),
            plugins: [
                new ClsPluginTransactional({
                    imports: [PrismaModule],
                    adapter: new TransactionalAdapterPrisma({
                        prismaInjectionToken: PrismaService,
                    }),
                }),
            ],
        }),
    ],
    exports: [NestClsModule],
})
export class ClsModule {}

// 导出 ClsService 以便其他模块使用
export { ClsService };
