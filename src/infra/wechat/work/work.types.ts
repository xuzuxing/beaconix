/**
 * Enterprise WeChat (企业微信) application API types.
 *
 * Docs: https://developer.work.weixin.qq.com/document/path/90236
 */

export interface WorkAccessTokenInput {
    corpId?: string;
    corpSecret?: string;
}

export interface WorkAppTextMessage {
    content: string;
}

export interface WorkAppMarkdownMessage {
    content: string;
}

export interface WorkAppTextCardMessage {
    title: string;
    description: string;
    url: string;
    /** Up to 4 Chinese characters, defaults to "详情". */
    btntxt?: string;
}

export type WorkAppMessageContent =
    | { msgType: 'text'; text: WorkAppTextMessage }
    | { msgType: 'markdown'; markdown: WorkAppMarkdownMessage }
    | { msgType: 'textcard'; textcard: WorkAppTextCardMessage };

export interface SendWorkAppMessageInput extends WorkAccessTokenInput {
    content: WorkAppMessageContent;
    /** User ids; `@all` targets everyone. */
    toUser?: string | string[];
    toParty?: string | string[];
    toTag?: string | string[];
    /** Defaults to `WECHAT_WORK_AGENTID`. */
    agentId?: string;
    safe?: 0 | 1;
}

export interface SendWorkAppMessageResult {
    msgId: string;
    invalidUser: string[];
    invalidParty: string[];
    invalidTag: string[];
}

export interface WorkDepartment {
    id: number;
    name: string;
    parentid: number;
    order: number;
}

export interface WorkUser {
    userid: string;
    name: string;
    department: number[];
    mobile?: string;
    email?: string;
    position?: string;
    status?: number;
}

export interface WorkUserInput extends WorkAccessTokenInput {
    userId: string;
}

export interface ListWorkUsersInput extends WorkAccessTokenInput {
    departmentId: number;
    /** Include sub-departments (defaults to false). */
    fetchChild?: boolean;
}
