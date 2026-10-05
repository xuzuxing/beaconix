import { Global, Module } from '@nestjs/common';
import { SharedSubscriptionModule } from '../subscription/subscription.module';
import { QuotaService } from './quota.service';

@Global()
@Module({
    imports: [SharedSubscriptionModule],
    providers: [QuotaService],
    exports: [QuotaService],
})
export class QuotaModule {}
