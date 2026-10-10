import { NestFactory, Reflector } from '@nestjs/core';
import {
    ClassSerializerInterceptor,
    Logger,
    ShutdownSignal,
    ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import helmet from 'helmet';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { AppConfig } from './config';
import { GlobalExceptionFilter } from './common/filters';
import { TransformInterceptor } from './common/interceptors';

async function bootstrap() {
    // `rawBody` is required to verify WeChat Pay V3 signatures, which cover the
    // exact bytes of the callback payload.
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        rawBody: true,
    });
    const configService = app.get(ConfigService);
    const appConfig = configService.get<AppConfig>('app')!;
    const logger = new Logger('Bootstrap');

    // Global prefix
    app.setGlobalPrefix('api');

    app.enableCors({
        origin:
            appConfig.corsOrigins.length > 0 ? appConfig.corsOrigins : false,
        credentials: true,
    });

    // Views
    app.setBaseViewsDir(join(__dirname, '..', 'views'));
    app.setViewEngine('hbs');

    // Validation
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: false,
            transform: true,
            transformOptions: {
                enableImplicitConversion: true,
            },
        }),
    );

    // Global interceptors
    app.useGlobalInterceptors(
        new TransformInterceptor(),
        new ClassSerializerInterceptor(app.get(Reflector)),
    );

    // Global exception filter
    app.useGlobalFilters(new GlobalExceptionFilter());
    // 启用安全头并自定义 CSP
    app.use(
        helmet({
            contentSecurityPolicy: {
                directives: {
                    scriptSrc: [
                        "'self'",
                        "'unsafe-inline'",
                        'https://cdn.jsdelivr.net', // 放行 Scalar CDN
                    ],
                    // style-src 仍需 'unsafe-inline'，Scalar 渲染大量行内 style 属性
                    styleSrc: ["'self'", "'unsafe-inline'"],
                },
            },
        }),
    );

    // Swagger
    const swaggerConfig = new DocumentBuilder()
        .setTitle('Beacon API')
        .setDescription('Multi-tenant project management platform API')
        .setVersion('1.0')
        .addBearerAuth(
            { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            'access-token',
        )
        .addBearerAuth(
            {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'API key (bk_org_...)',
                description: 'Organization API key for the developer API',
            },
            'developer-api-key',
        )
        .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig, {
        ignoreGlobalPrefix: false,
    });
    app.use(
        '/api/docs',
        apiReference({
            content: document,
            localization: {
                locale: 'zh-CN',
            },
        }),
    );

    app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT]);

    await app.listen(appConfig.port, () => {
        logger.log(
            `Application running on port http://localhost:${appConfig.port} with env ${appConfig.env}`,
        );
        logger.log(
            `Swagger docs available at http://localhost:${appConfig.port}/api/docs`,
        );
    });
}
void bootstrap();
