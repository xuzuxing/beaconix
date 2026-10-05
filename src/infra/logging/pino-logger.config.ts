import type { Params } from 'nestjs-pino';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { TransportMultiOptions, TransportTargetOptions } from 'pino';

const SENSITIVE_FIELD_PATTERNS: Record<
    string,
    'phone' | 'email' | 'idCard' | 'password' | 'bankCard'
> = {
    phone: 'phone',
    phonenumber: 'phone',
    mobile: 'phone',
    tel: 'phone',
    telephone: 'phone',
    email: 'email',
    mail: 'email',
    idcard: 'idCard',
    idcardno: 'idCard',
    identitycard: 'idCard',
    bankcard: 'bankCard',
    bankcardno: 'bankCard',
    cardno: 'bankCard',
    password: 'password',
    passwd: 'password',
    pwd: 'password',
    secret: 'password',
    token: 'password',
    accesstoken: 'password',
    refreshtoken: 'password',
    authorization: 'password',
    cookie: 'password',
    secretkey: 'password',
    apikey: 'password',
    smtppassword: 'password',
    accesskeysecret: 'password',
    appsecret: 'password',
};

interface AuthenticatedActor {
    userId?: string;
    userType?: 'admin' | 'app' | 'user';
    username?: string;
}

function maskPhone(phone: string): string {
    if (!phone || typeof phone !== 'string') return phone;
    const cleaned = phone.replace(/[\s-]/g, '');
    if (cleaned.length < 7) return phone;

    if (cleaned.startsWith('+')) {
        let countryCodeLen = 0;
        for (let i = 2; i <= 4 && i < cleaned.length; i++) {
            if (cleaned.length - i >= 7) {
                countryCodeLen = i;
                break;
            }
        }

        if (countryCodeLen > 0) {
            const countryCode = cleaned.slice(0, countryCodeLen);
            const number = cleaned.slice(countryCodeLen);
            return `${countryCode}${number.slice(0, 3)}****${number.slice(-4)}`;
        }

        return phone;
    }

    return `${cleaned.slice(0, 3)}****${cleaned.slice(-4)}`;
}

function maskEmail(email: string): string {
    if (!email || typeof email !== 'string' || !email.includes('@'))
        return email;

    const [local, domain] = email.split('@');
    if (!local || !domain) return email;

    return `${local.length <= 2 ? '**' : `${local[0]}**${local.slice(-1)}`}@${domain}`;
}

function maskIdCard(idCard: string): string {
    if (!idCard || typeof idCard !== 'string') return idCard;

    const cleaned = idCard.replace(/\s/g, '');
    if (cleaned.length < 10) return idCard;

    return `${cleaned.slice(0, 3)}${'*'.repeat(cleaned.length - 7)}${cleaned.slice(-4)}`;
}

function maskBankCard(bankCard: string): string {
    if (!bankCard || typeof bankCard !== 'string') return bankCard;

    const cleaned = bankCard.replace(/[\s-]/g, '');
    if (cleaned.length < 8) return bankCard;

    return `${cleaned.slice(0, 4)}${'*'.repeat(cleaned.length - 8)}${cleaned.slice(-4)}`;
}

function getSensitiveType(
    fieldName: string,
): 'phone' | 'email' | 'idCard' | 'password' | 'bankCard' | null {
    const normalizedFieldName = fieldName.toLowerCase().replace(/[_-]/g, '');
    return SENSITIVE_FIELD_PATTERNS[normalizedFieldName] || null;
}

function maskByType(
    value: string,
    type: 'phone' | 'email' | 'idCard' | 'password' | 'bankCard',
): string {
    switch (type) {
        case 'phone':
            return maskPhone(value);
        case 'email':
            return maskEmail(value);
        case 'idCard':
            return maskIdCard(value);
        case 'bankCard':
            return maskBankCard(value);
        case 'password':
            return '******';
    }
}

function autoDetectAndMask(value: string): string {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return maskEmail(value);
    if (/^1[3-9]\d{9}$/.test(value)) return maskPhone(value);
    if (/^\d{17}[\dXx]$/.test(value)) return maskIdCard(value);
    if (/^\d{16,19}$/.test(value)) return maskBankCard(value);
    return value;
}

export function smartMask(value: unknown, fieldPath: string): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'number' || typeof value === 'boolean')
        return value.toString();
    if (typeof value === 'bigint' || typeof value === 'symbol')
        return value.toString();
    if (typeof value !== 'string') return JSON.stringify(value) ?? '';

    const fieldName = fieldPath.split('.').pop() || fieldPath;
    const sensitiveType = getSensitiveType(fieldName);

    return sensitiveType
        ? maskByType(value, sensitiveType)
        : autoDetectAndMask(value);
}

export function maskObjectDeep(
    obj: unknown,
    sensitiveFields: string[],
): unknown {
    if (!obj || typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
        return obj.map((item) => maskObjectDeep(item, sensitiveFields));
    }

    const masked = { ...(obj as Record<string, unknown>) };
    for (const key of Object.keys(masked)) {
        const value = masked[key];
        if (value === null || value === undefined) continue;

        const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
        const isSensitive =
            getSensitiveType(key) !== null ||
            sensitiveFields.some((field) => {
                const normalizedField = field
                    .toLowerCase()
                    .replace(/[_-]/g, '');
                return (
                    normalizedKey === normalizedField ||
                    normalizedKey.includes(normalizedField)
                );
            });

        if (typeof value === 'string') {
            if (isSensitive) {
                masked[key] = getSensitiveType(key)
                    ? smartMask(value, key)
                    : '******';
            }
        } else if (isSensitive) {
            masked[key] = '******';
        } else if (typeof value === 'object') {
            masked[key] = maskObjectDeep(value, sensitiveFields);
        }
    }

    return masked;
}

export function getHeaderValue(value: unknown): string | undefined {
    if (Array.isArray(value)) return value[0];
    return typeof value === 'string' ? value : undefined;
}

function getResponseHeader(res: any, header: string): string | undefined {
    const value = res?.getHeader?.(header) ?? res?.getHeaders?.()?.[header];
    return getHeaderValue(value);
}

export function getRequestId(req: any, res?: any): string {
    return (
        getResponseHeader(res, 'X-Request-Id') ||
        getResponseHeader(res, 'x-request-id') ||
        getHeaderValue(req?.headers?.['x-request-id']) ||
        'unknown'
    );
}

function getPath(req: any): string | undefined {
    const url = req?.originalUrl || req?.url || req?.path;
    return typeof url === 'string' ? url.split(/[?#]/)[0] : undefined;
}

function getActor(req: any): AuthenticatedActor {
    if (req?.admin) {
        return {
            userId: req.admin.id,
            userType: 'admin',
            username: req.admin.username || req.admin.displayName,
        };
    }

    if (req?.appUser) {
        return {
            userId: req.appUser.id,
            userType: 'app',
            username:
                req.appUser.username ||
                req.appUser.nickname ||
                req.appUser.phone ||
                req.appUser.email,
        };
    }

    const user = req?.user?.user || req?.user;
    if (user) {
        return {
            userId: user.userId || user.id || user.sub,
            userType: 'user',
            username:
                user.userName ||
                user.username ||
                user.displayName ||
                user.nickname ||
                user.phone ||
                user.email,
        };
    }

    return {};
}

function resolveLogDir(logDir: string): string {
    return path.isAbsolute(logDir)
        ? logDir
        : path.resolve(process.cwd(), logDir);
}

interface PinoConfigOptions {
    serviceName?: string;
    env?: string;
    toConsole?: boolean;
    getRequestId?: () => string | undefined;
}

function createTransport(
    logDir: string,
    level: string,
    prettyPrint: boolean,
    toFile: boolean,
    options: PinoConfigOptions,
): TransportMultiOptions | undefined {
    const env = options.env || process.env.NODE_ENV || 'development';
    const toConsole = options.toConsole ?? true;

    if (!toFile && !(toConsole && prettyPrint)) {
        return undefined;
    }

    const absoluteLogDir = resolveLogDir(logDir);
    if (toFile && !fs.existsSync(absoluteLogDir)) {
        fs.mkdirSync(absoluteLogDir, { recursive: true });
    }

    const prettyTarget: TransportTargetOptions = {
        target: require.resolve('pino-pretty'),
        level,
        options: {
            colorize: true,
            sync: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
            singleLine: false,
            messageFormat: '{requestId} - {msg}',
        },
    };

    const fileTarget = {
        target: 'pino/file',
        level,
        options: {
            destination: path.join(
                absoluteLogDir,
                `app-${env}-${new Date().toISOString().split('T')[0]}.log`,
            ),
            mkdir: true,
        },
    };

    const targets: TransportTargetOptions[] = [];
    if (toConsole && prettyPrint) targets.push(prettyTarget);
    if (toFile) targets.push(fileTarget);

    return { targets };
}

export function createPinoConfig(
    logDir: string,
    level: string,
    prettyPrint: boolean,
    toFile: boolean,
    excludePaths: string[],
    sensitiveFields: string[],
    options: PinoConfigOptions = {},
): Params {
    const env = options.env || process.env.NODE_ENV || 'development';
    const transport = createTransport(
        logDir,
        level,
        prettyPrint,
        toFile,
        options,
    );
    const numericLevel = transport !== undefined;
    // Without a transport Pino defaults to stdout, even when console is disabled.
    const outputLevel =
        options.toConsole === false && !transport ? 'silent' : level;
    const redactPaths = sensitiveFields.flatMap((field) => [
        field,
        `*.${field}`,
        `req.body.${field}`,
        `req.body.*.${field}`,
        `req.query.${field}`,
        `req.headers.${field}`,
        `req.raw.body.${field}`,
        `req.raw.body.*.${field}`,
        `req.raw.query.${field}`,
        `req.raw.headers.${field}`,
    ]);

    return {
        pinoHttp: {
            level: outputLevel,
            base: {
                pid: process.pid,
                hostname: os.hostname(),
                application: 'beacon',
                service: options.serviceName || 'beacon',
                env,
            },
            redact: {
                paths: redactPaths,
                censor: (value: unknown, path: string[]) =>
                    typeof value === 'string' &&
                    getSensitiveType(path[path.length - 1] || '')
                        ? smartMask(value, path[path.length - 1])
                        : '******',
            },
            transport,
            genReqId: (req, res) =>
                options.getRequestId?.() || getRequestId(req, res),
            formatters: {
                level: (label, number) =>
                    numericLevel
                        ? { level: number, levelName: label }
                        : { level: label },
            },
            customProps: (req: any, res: any) => {
                const actor = getActor(req);
                const requestId =
                    options.getRequestId?.() || getRequestId(req, res);

                return {
                    requestId,
                    method: req?.method,
                    path: getPath(req),
                    statusCode: res?.statusCode,
                    ip: req?.ip,
                    userAgent: req?.headers?.['user-agent'],
                    ...actor,
                    username: actor.username
                        ? autoDetectAndMask(actor.username)
                        : undefined,
                };
            },
            serializers: {
                req(req) {
                    const raw = req.raw || req;
                    return {
                        method: req.method,
                        url: getPath(raw),
                        path: getPath(raw),
                        query: maskObjectDeep(
                            raw?.query || req.query,
                            sensitiveFields,
                        ),
                        params: maskObjectDeep(
                            raw?.params || req.params,
                            sensitiveFields,
                        ),
                        body: raw?.body
                            ? maskObjectDeep(raw.body, sensitiveFields)
                            : undefined,
                        headers: {
                            host: req.headers.host,
                            'content-type': req.headers['content-type'],
                            'user-agent': req.headers['user-agent'],
                            referer: getPath({ url: req.headers.referer }),
                            'x-encrypted': req.headers['x-encrypted'],
                            'x-request-id': getHeaderValue(
                                req.headers['x-request-id'],
                            ),
                        },
                    };
                },
                res(res) {
                    return {
                        statusCode: res.statusCode,
                        headers: res.getHeaders
                            ? {
                                  'content-type': res.getHeader('content-type'),
                                  'content-length':
                                      res.getHeader('content-length'),
                              }
                            : {},
                    };
                },
                err(err) {
                    return {
                        type: err.constructor.name,
                        message: err.message,
                        stack: env === 'development' ? err.stack : undefined,
                        code: err.code,
                        ...(err.response && { response: err.response }),
                        ...(err.status && { status: err.status }),
                    };
                },
            },
            customLogLevel: (_req, res, err) => {
                if (res.statusCode >= 500 || err) return 'error';
                if (res.statusCode >= 400) return 'warn';
                return 'info';
            },
            customSuccessMessage: (req, res) => {
                if (res.statusCode === 404) return 'Resource not found';
                return `${req.method} ${getPath(req)} completed`;
            },
            customErrorMessage: (req, _res, err) =>
                `${req.method} ${getPath(req)} failed: ${err.message}`,
            autoLogging: {
                ignore: (req) =>
                    excludePaths.some((excludePath) =>
                        req.url?.startsWith(excludePath),
                    ),
            },
        },
    };
}
