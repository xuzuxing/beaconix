import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * An HTTP exception that carries a stable, machine-readable business `code`
 * alongside the human-readable message.
 *
 * `GlobalExceptionFilter` surfaces `code` verbatim in the error response body
 * so clients can branch on it (e.g. `INVALID_TWO_FACTOR_CODE`) instead of
 * matching on message text:
 *
 * ```json
 * { "statusCode": 401, "code": "INVALID_TWO_FACTOR_CODE", "message": "..." }
 * ```
 */
export class BusinessException extends HttpException {
    constructor(status: HttpStatus, code: string, message: string) {
        super({ code, message }, status);
    }
}
