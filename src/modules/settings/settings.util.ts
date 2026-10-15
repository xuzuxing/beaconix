/**
 * 平台配置值的纯函数工具。
 *
 * `develop.configGroup` 这类「字符串数组」配置项，写入口与读出口用两套宽严不同的规则：
 * 写入从严（非法值一律拒绝），读取从宽（规范化后返回，绝不把非法值原样交给前端）。
 */

/** 是否是合法的字符串数组：非空、无空白项、无重复项 */
export function isValidStringArray(value: unknown): boolean {
    if (!Array.isArray(value) || value.length === 0) return false;

    const seen = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== 'string') return false;
        const normalized = entry.trim();
        if (!normalized || seen.has(normalized)) return false;
        seen.add(normalized);
    }

    return true;
}

/** 规范化字符串数组：剔除非字符串 / 空白项并去重；不是数组或没有合法项时返回 null */
export function normalizeStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;

    const result: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const normalized = entry.trim();
        if (normalized && !result.includes(normalized)) {
            result.push(normalized);
        }
    }

    return result.length ? result : null;
}
