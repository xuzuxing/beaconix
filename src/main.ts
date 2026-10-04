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
import { createRouteHandler } from 'uploadthing/express';
import { AppModule } from './app.module';
import { AppConfig } from './config';
import { GlobalExceptionFilter } from './common/filters';
import { TransformInterceptor } from './common/interceptors';
import { uploadRouter } from './modules/attachments/upload.router';

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    const configService = app.get(ConfigService);
    const appConfig = configService.get<AppConfig>('app')!;
    const logger = new Logger('Bootstrap');
    const expressApp = app.getHttpAdapter().getInstance();

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
            forbidNonWhitelisted: true,
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

    // UploadThing route handler (before Swagger, after global prefix)
    expressApp.use(
        '/api/uploadthing',
        createRouteHandler({ router: uploadRouter }),
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
        .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    app.use(
        '/reference',
        apiReference({
            content: document,
        }),
    );
    app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT]);

    await app.listen(appConfig.port, () => {
        logger.log(
            `Application running on port http://localhost:${appConfig.port} with env ${appConfig.env}`,
        );
        logger.log(
            `Swagger docs available at http://localhost:${appConfig.port}/reference`,
        );
    });
}
void bootstrap();
