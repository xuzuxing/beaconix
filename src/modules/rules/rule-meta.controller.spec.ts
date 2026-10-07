import { RuleMetaController } from './rule-meta.controller';
import { FIELD_META, RULE_FIELDS, STATUS_CLASS_VALUES } from './types';

describe('RuleMetaController', () => {
    it('returns fields, metadata and status classes', () => {
        const controller = new RuleMetaController();

        const meta = controller.getMeta();

        expect(meta.fields).toEqual(RULE_FIELDS);
        expect(meta.meta).toBe(FIELD_META);
        expect(meta.statusClassValues).toEqual(STATUS_CLASS_VALUES);
        expect(meta.meta.statusCode.operators).toContain('statusClass');
    });
});
