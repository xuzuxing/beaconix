import { SettingValueType } from '../../generated/prisma/enums';

export interface SettingDefinition {
    key: string;
    name: string;
    value: string | number | boolean | Record<string, unknown> | unknown[];
    valueType: SettingValueType;
    description: string;
    isSecret?: boolean;
}

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
    {
        key: 'storage.driver',
        name: 'Storage Driver',
        value: 'local',
        valueType: SettingValueType.STRING,
        description: 'Active attachment storage driver: local or oss.',
    },
    {
        key: 'storage.publicBaseUrl',
        name: 'Local Storage Public Base URL',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            'Optional public base URL for local attachment objects. Empty keeps API streaming downloads.',
    },
    {
        key: 'storage.oss.publicBaseUrl',
        name: 'OSS Public Base URL',
        value: '',
        valueType: SettingValueType.STRING,
        description:
            'Optional public/CDN base URL for OSS objects. Empty uses signed download URLs.',
    },
    {
        key: 'storage.oss.signedUrlTtlSeconds',
        name: 'OSS Signed URL TTL',
        value: 300,
        valueType: SettingValueType.NUMBER,
        description: 'TTL in seconds for generated OSS signed download URLs.',
    },
    {
        key: 'attachments.maxImageSizeMb',
        name: 'Max Image Upload Size',
        value: 8,
        valueType: SettingValueType.NUMBER,
        description: 'Maximum image upload size in MB.',
    },
    {
        key: 'attachments.maxPdfSizeMb',
        name: 'Max PDF Upload Size',
        value: 16,
        valueType: SettingValueType.NUMBER,
        description: 'Maximum PDF upload size in MB.',
    },
    {
        key: 'attachments.maxBlobSizeMb',
        name: 'Max Blob Upload Size',
        value: 32,
        valueType: SettingValueType.NUMBER,
        description: 'Maximum upload size in MB for other allowed file types.',
    },
    {
        key: 'attachments.maxFilesPerRequest',
        name: 'Max Files Per Request',
        value: 5,
        valueType: SettingValueType.NUMBER,
        description: 'Reserved batch upload file count limit.',
    },
] as const;

export const SETTING_DEFINITION_MAP: ReadonlyMap<string, SettingDefinition> =
    new Map(
        SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
    );
