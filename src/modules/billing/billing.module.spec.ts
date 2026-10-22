import { MODULE_METADATA } from '@nestjs/common/constants';
import { BillingModule } from './billing.module';
import { PaymentProviderFactory } from './payment/payment-provider.factory';
import { PaymentProviderModule } from './payment/payment-provider.module';
import { RefundModule } from './refund/refund.module';
import { RefundService } from './refund/refund.service';

/**
 * `UnknownExportException` / 依赖解析失败只在 `NestFactory.create()` 阶段抛，
 * 单测里装配一遍太重，所以这里用反射校验模块元数据：
 * 1. exports 里每一项都必须是自身 provider 或已导入模块；
 * 2. `RefundService` 依赖的 `PaymentProviderFactory` 所在模块必须被 RefundModule 导入。
 */
const reflectList = (key: string, target: unknown): unknown[] =>
    (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

const expectExportsResolvable = (module: unknown): void => {
    const providers = reflectList(MODULE_METADATA.PROVIDERS, module);
    const imports = reflectList(MODULE_METADATA.IMPORTS, module);
    const exported = reflectList(MODULE_METADATA.EXPORTS, module);

    const unknown = exported.filter(
        (item) => !providers.includes(item) && !imports.includes(item),
    );

    expect(unknown).toEqual([]);
};

describe('BillingModule 模块装配', () => {
    it.each([
        ['BillingModule', BillingModule],
        ['RefundModule', RefundModule],
        ['PaymentProviderModule', PaymentProviderModule],
    ])('%s 的 exports 只包含自身 provider 或已导入模块', (_name, module) => {
        expectExportsResolvable(module);
    });

    it('BillingModule 通过转发 RefundModule 对外暴露 RefundService', () => {
        expect(reflectList(MODULE_METADATA.IMPORTS, BillingModule)).toContain(
            RefundModule,
        );
        expect(reflectList(MODULE_METADATA.EXPORTS, BillingModule)).toContain(
            RefundModule,
        );
        expect(reflectList(MODULE_METADATA.EXPORTS, RefundModule)).toContain(
            RefundService,
        );
    });

    it('RefundModule 导入 PaymentProviderModule，RefundService 的渠道工厂才能解析', () => {
        expect(reflectList(MODULE_METADATA.IMPORTS, RefundModule)).toContain(
            PaymentProviderModule,
        );
        expect(
            reflectList(MODULE_METADATA.EXPORTS, PaymentProviderModule),
        ).toContain(PaymentProviderFactory);
    });
});
