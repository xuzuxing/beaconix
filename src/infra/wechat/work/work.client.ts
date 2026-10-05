import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WechatConfig, WechatWorkConfig } from '../../../config';
import { WechatHttpClient } from '../clients/wechat-http.client';
import {
    type AccessTokenCredentials,
    WechatTokenService,
    withAccessToken,
} from '../clients/wechat-token.service';
import { WechatApiError, WechatConfigurationError } from '../wechat.types';
import type {
    ListWorkUsersInput,
    SendWorkAppMessageInput,
    SendWorkAppMessageResult,
    WorkDepartment,
    WorkUser,
    WorkUserInput,
} from './work.types';

const MESSAGE_SEND_PATH = '/cgi-bin/message/send';
const DEPARTMENT_LIST_PATH = '/cgi-bin/department/list';
const USER_GET_PATH = '/cgi-bin/user/get';
const USER_LIST_PATH = '/cgi-bin/user/list';

interface SendMessageResponse {
    msgid?: string | number;
    invaliduser?: string;
    invalidparty?: string;
    invalidtag?: string;
}

interface DepartmentListResponse {
    department?: WorkDepartment[];
}

interface WorkUserResponse extends Partial<WorkUser> {
    errcode?: number;
    errmsg?: string;
}

interface UserListResponse {
    userlist?: WorkUser[];
}

/** Joins an id list the way the enterprise WeChat API expects. */
function joinTargets(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return value.join('|');
    return value ?? '';
}

/** Splits a `a|b|c` id list from a response into an array. */
function splitTargets(value: string | undefined): string[] {
    if (!value) return [];
    return value.split('|').filter((item) => item !== '');
}

/**
 * Enterprise WeChat (企业微信) application client.
 *
 * Covers application messages and the contact directory. The group-robot
 * webhook used by `WecomSender` is a different API and stays out of this
 * sub-package — it needs no access token.
 */
@Injectable()
export class WorkClient {
    private readonly logger = new Logger(WorkClient.name);

    constructor(
        private readonly http: WechatHttpClient,
        private readonly tokens: WechatTokenService,
        private readonly configService: ConfigService,
    ) {}

    /** Sends an application message to users / departments / tags. */
    async sendAppMessage(
        input: SendWorkAppMessageInput,
    ): Promise<SendWorkAppMessageResult> {
        const credentials = this.resolveCredentials(input);
        const agentId = this.resolveAgentId(input.agentId);

        const body: Record<string, unknown> = {
            touser: joinTargets(input.toUser),
            toparty: joinTargets(input.toParty),
            totag: joinTargets(input.toTag),
            msgtype: input.content.msgType,
            agentid: agentId,
            safe: input.safe ?? 0,
        };

        switch (input.content.msgType) {
            case 'text':
                body.text = input.content.text;
                break;
            case 'markdown':
                body.markdown = input.content.markdown;
                break;
            case 'textcard':
                body.textcard = input.content.textcard;
                break;
        }

        const response = await withAccessToken(
            this.tokens,
            credentials,
            (accessToken) =>
                this.http.postJson<SendMessageResponse>(
                    `${MESSAGE_SEND_PATH}?access_token=${encodeURIComponent(accessToken)}`,
                    body,
                    { retries: 0, platform: 'work' },
                ),
            this.logger,
        );

        return {
            msgId: response.msgid === undefined ? '' : String(response.msgid),
            invalidUser: splitTargets(response.invaliduser),
            invalidParty: splitTargets(response.invalidparty),
            invalidTag: splitTargets(response.invalidtag),
        };
    }

    /** Lists departments, optionally only the subtree of `departmentId`. */
    async getDepartmentList(
        input: { departmentId?: number } & {
            corpId?: string;
            corpSecret?: string;
        } = {},
    ): Promise<WorkDepartment[]> {
        const credentials = this.resolveCredentials(input);

        const response = await withAccessToken(
            this.tokens,
            credentials,
            (accessToken) =>
                this.http.getJson<DepartmentListResponse>(
                    `${DEPARTMENT_LIST_PATH}?access_token=${encodeURIComponent(accessToken)}`,
                    {
                        query:
                            input.departmentId === undefined
                                ? undefined
                                : { id: input.departmentId },
                        retries: 0,
                        platform: 'work',
                    },
                ),
            this.logger,
        );

        return response.department ?? [];
    }

    /** Reads one member of the contact directory. */
    async getUser(input: WorkUserInput): Promise<WorkUser> {
        const credentials = this.resolveCredentials(input);

        const response = await withAccessToken(
            this.tokens,
            credentials,
            (accessToken) =>
                this.http.getJson<WorkUserResponse>(
                    `${USER_GET_PATH}?access_token=${encodeURIComponent(accessToken)}`,
                    {
                        query: { userid: input.userId },
                        retries: 0,
                        platform: 'work',
                    },
                ),
            this.logger,
        );

        if (!response.userid) {
            throw new WechatApiError({
                platform: 'work',
                endpoint: `GET ${USER_GET_PATH}`,
                errcode: response.errcode,
                errmsg:
                    response.errmsg ??
                    'Enterprise WeChat user response is missing userid',
            });
        }

        return {
            userid: response.userid,
            name: response.name ?? '',
            department: response.department ?? [],
            mobile: response.mobile,
            email: response.email,
            position: response.position,
            status: response.status,
        };
    }

    /** Lists the members of a department. */
    async listUsersByDepartment(
        input: ListWorkUsersInput,
    ): Promise<WorkUser[]> {
        const credentials = this.resolveCredentials(input);

        const response = await withAccessToken(
            this.tokens,
            credentials,
            (accessToken) =>
                this.http.getJson<UserListResponse>(
                    `${USER_LIST_PATH}?access_token=${encodeURIComponent(accessToken)}`,
                    {
                        query: {
                            department_id: input.departmentId,
                            fetch_child: input.fetchChild ? 1 : 0,
                        },
                        retries: 0,
                        platform: 'work',
                    },
                ),
            this.logger,
        );

        return response.userlist ?? [];
    }

    // -- Helpers ---------------------------------------------------------

    private resolveCredentials(input: {
        corpId?: string;
        corpSecret?: string;
    }): AccessTokenCredentials {
        const config = this.workConfig;
        const corpId = input.corpId ?? config.corpId;
        const corpSecret = input.corpSecret ?? config.corpSecret;

        if (!corpId || !corpSecret) {
            throw new WechatConfigurationError(
                'Enterprise WeChat corpId/corpSecret are required (WECHAT_WORK_CORPID / WECHAT_WORK_CORPSECRET)',
            );
        }

        return { kind: 'work', corpId, corpSecret };
    }

    private resolveAgentId(override?: string): number {
        const agentId = override ?? this.workConfig.agentId;

        if (!agentId) {
            throw new WechatConfigurationError(
                'WECHAT_WORK_AGENTID is required to send an enterprise WeChat app message',
            );
        }

        const numeric = Number(agentId);

        if (!Number.isInteger(numeric) || numeric <= 0) {
            throw new WechatConfigurationError(
                'WECHAT_WORK_AGENTID must be a positive integer',
            );
        }

        return numeric;
    }

    private get workConfig(): WechatWorkConfig {
        const wechat = this.configService.get<WechatConfig>('wechat');

        if (!wechat) {
            throw new WechatConfigurationError(
                'WeChat config is not registered',
            );
        }

        return wechat.work;
    }
}
