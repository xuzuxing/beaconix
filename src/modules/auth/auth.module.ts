import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { WechatAuthController } from './wechat/wechat-auth.controller';
import { WechatAuthService } from './wechat/wechat-auth.service';
import { WechatScanLoginService } from './wechat/wechat-scan-login.service';
import { TwoFactorController } from './two-factor/two-factor.controller';
import { TwoFactorService } from './two-factor/two-factor.service';
import { TwoFactorCryptoService } from './two-factor/two-factor-crypto.service';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
    imports: [OrganizationsModule],
    controllers: [AuthController, WechatAuthController, TwoFactorController],
    providers: [
        AuthService,
        WechatAuthService,
        WechatScanLoginService,
        TwoFactorService,
        TwoFactorCryptoService,
    ],
    exports: [AuthService],
})
export class AuthModule {}
