import type { MonitorType } from '../../../generated/prisma/enums';
import type { MonitorModel } from '../../../generated/prisma/models';
import type { CheckResult } from './check-result';

export interface CheckerStrategy {
    readonly type: MonitorType;
    run(monitor: MonitorModel): Promise<CheckResult>;
}
