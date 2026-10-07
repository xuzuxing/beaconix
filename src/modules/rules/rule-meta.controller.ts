import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { FIELD_META, RULE_FIELDS, STATUS_CLASS_VALUES } from './types';

@ApiTags('Rule Meta')
@Controller('rule-meta')
export class RuleMetaController {
    @Get()
    @Public()
    @ApiOperation({
        summary: 'Rule field/operator metadata for building rule editors',
    })
    @ApiOkResponse({
        description:
            'Fields, per-field operators/constraints/defaults, and status classes',
    })
    getMeta() {
        return {
            fields: RULE_FIELDS,
            meta: FIELD_META,
            statusClassValues: STATUS_CLASS_VALUES,
        };
    }
}
