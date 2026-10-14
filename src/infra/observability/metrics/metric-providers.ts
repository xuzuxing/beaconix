import { Inject, type Provider } from '@nestjs/common';
import {
    Gauge,
    type GaugeConfiguration,
    register,
} from '@prometheus-io/client';

const METRIC_TOKEN_PREFIX = 'OMNI_PROMETHEUS_METRIC';

export function getMetricToken(name: string): string {
    return `${METRIC_TOKEN_PREFIX}:${name}`;
}

export function InjectMetric(name: string) {
    return Inject(getMetricToken(name));
}

export function makeGaugeProvider<T extends string>(
    configuration: GaugeConfiguration<T>,
): Provider<Gauge<T>> {
    return {
        provide: getMetricToken(configuration.name),
        useFactory: () =>
            (register.getSingleMetric(configuration.name) as
                Gauge<T> | undefined) ?? new Gauge(configuration),
    };
}
