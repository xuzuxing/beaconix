import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { WechatAuthController } from './wechat/wechat-auth.controller';
import { WechatAuthService } from './wechat/wechat-auth.service';
import { WechatScanLoginService } from './wechat/wechat-scan-login.service';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
    imports: [OrganizationsModule],
    controllers: [AuthController, WechatAuthController],
    providers: [AuthService, WechatAuthService, WechatScanLoginService],
    exports: [AuthService],
})
export class AuthModule {}
