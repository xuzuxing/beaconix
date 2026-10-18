# 设置页分组（section）：现状与三套轻量化方案

平台配置页（`/admin/settings`）的 tab 内支持二级分组。当前分组归属写死在代码里，每加一次分组要改三处并重启。本文记录现状、成本，以及三套更轻量的可行方案，供后续选型。

> 状态：**方案一 1A 已实施**（其余为提案）。现行行为以源码与 Swagger 为准。

## 背景

需求最早来自 `wechat` tab：26 个配置项平铺在一个 tab 里太长，于是引入了 `section` 字段做二级分组，后端下发、前端渲染小标题。

问题在于分组归属只能由代码声明，于是「给另一个 tab 开分组」的动作变成了：

1. 后端 `settings.defaults.ts` 给该 tab 的每一项加 `section`
2. 前端 `AdminSettingsView.vue` 的 `SECTION_LABEL_KEYS` 加映射
3. 前端两份 locales 加 `section` / `sectionHint` 文案
4. 重新部署并重启服务（`section` 不入库，改动无法热更新）

## 现状：`section` 是代码侧元数据

### 数据流

```text
SETTING_DEFINITIONS[].section          后端内置定义（代码）
        ↓
SettingEntity.section                  出厂时随实体下发，未声明则为 undefined
        ↓
GET /admin/settings                    每项多一个 section 字段
        ↓
buildSettingTabs()                     按 group 拆 tab，再按 section 拆块
        ↓
AdminSettingView                       每块前渲染小标题 + 说明
```

### 涉及位置

| 端 | 文件 | 位置 | 作用 |
| --- | --- | --- | --- |
| 后端 | `src/modules/settings/settings.defaults.ts` | `SettingDefinition.section` 定义处 | 声明字段与规则注释 |
| 后端 | 同上 | 26 项 `wechat.*` | 显式声明 `pay` / `scanLogin` 等 7 个 section |
| 后端 | `src/modules/settings/settings.service.ts` | `findAll`（第 58-78 行）、`entityFromRow`（第 264 行起） | 把定义的 section 传到实体 |
| 后端 | `src/modules/settings/entities/setting.entity.ts` | `section?: string` | 对外契约 |
| 前端 | `src/api/types/admin.ts` | `AdminSetting.section?: string` | 类型 |
| 前端 | `src/utils/settings-presenter.ts` | `buildSections`（第 143 行）、`buildSettingTabs`（第 155 行） | 切块 |
| 前端 | `src/views/admin/AdminSettingsView.vue` | `SECTION_LABEL_KEYS`（第 74 行）、`sectionLabel`（84）、`tabHasSections`（95）、模板（207-209） | 小标题与渲染 |
| 前端 | `src/locales/admin.zh-CN.ts` / `admin.en-US.ts` | `section`（367 / 380）、`sectionHint`（376 / 389） | 中英文文案 |

### 两条隐含约束

- **同一 tab 要么全部分组、要么都不分。** 未声明 section 的项会形成一个无标题块，位置按它首次出现的地方；与带标题的块混排时视觉很跳。
- **`SECTION_LABEL_KEYS` 按 section key 全局映射。** 两个 tab 用同一个 key（比如都叫 `http`）会共享同一份标题文案，想区分就得把 key 起成带域的（`ossHttp` / `payHttp`）。

## 方案一：按 key 自动推断（推荐）

让 `section` 从 key 的层级派生：`wechat.pay.mchId` → `pay` 段，`wechat.scanLogin.page` → `scanLogin` 段。**以后加新 tab 只要 key 起成三层，零配置。**

### 规则

- **显式优先**：项上写了 `section` 就用它。
- **全或无**：只有该 tab 内**每一项** key 都能切出第二段（≥3 段）时才自动分段，否则整 tab 平铺 —— 避免无标题块混排。

### 1A：后端实现（契约层统一）✅ 已实施

`src/modules/settings/settings.service.ts` 新增私有方法：

```ts
    /**
     * 未显式声明 section 的项按 key 的第二段自动归类，让新增 tab 不必再改代码。
     * 全或无：只有组内每一项都能切出第二段时才分段，避免带标题的块与无标题的块
     * 混排；显式声明的 section 永远优先。
     */
    private deriveSections(entities: SettingEntity[]): SettingEntity[] {
        const byGroup = new Map<string, SettingEntity[]>()
        entities.forEach((entity) => {
            const list = byGroup.get(entity.group)
            if (list) list.push(entity)
            else byGroup.set(entity.group, [entity])
        })

        byGroup.forEach((items) => {
            if (!items.every((item) => item.key.split('.').length >= 3)) return
            items.forEach((item) => {
                if (item.section === undefined) item.section = item.key.split('.')[1]
            })
        })

        return entities
    }
```

`findAll` 的返回值（第 78 行）改为：

```ts
        return this.deriveSections([...defaults, ...custom]);
```

影响面：只改 `findAll` 的输出，`findOne` 保持原样（单页编辑不承载整组上下文）；`findPublic` 仍然只挑 `isPublic && !isSecret`，`section` 不进公开快照。

> 实测注意：section key 直接取 **key 的第二段原文**，所以 `wechat.miniprogram.*` 得到的是 `miniprogram`（全小写），而不是早先显式声明的 `miniProgram`。前端 `SECTION_LABEL_KEYS` 的映射键要跟着改成小写，否则会回退显示原始 key。

### 1B：前端实现（只动展示层）

`src/utils/settings-presenter.ts` 的 `buildSections`（第 143 行）替换为：

```ts
/** 全或无的自动推断：该 tab 内每一项 key 都有 ≥3 段时才按第二段分组 */
function canDeriveSections(items: AdminSetting[]): boolean {
  return items.length > 0 && items.every((item) => item.key.split('.').length >= 3)
}

function buildSections(items: AdminSetting[]): SettingSection[] {
  const derived = canDeriveSections(items)
  const bySection = new Map<string, AdminSetting[]>()
  items.forEach((item) => {
    const key =
      item.section !== undefined
        ? item.section.trim()
        : derived
          ? (item.key.split('.')[1] ?? '')
          : ''
    const list = bySection.get(key)
    if (list) list.push(item)
    else bySection.set(key, [item])
  })
  return Array.from(bySection, ([key, sectionItems]) => ({ key, items: sectionItems }))
}
```

影响面：仅管理页；后端 `section` 字段可保留（显式覆盖）也可以不再下发。

### 两个变体的差异

| | 1A 后端 | 1B 前端 |
| --- | --- | --- |
| 改动量 | 约 15 行 + 一次重启 | 约 18 行，纯前端发版 |
| 生效范围 | 所有客户端（含将来的 SDK / 移动端） | 只有这个页面 |
| 后端 `section` 字段 | 作为显式覆盖保留 | 可保留可弃用 |

### 效果示例

- `wechat` tab：全部三层 key → 自动得到 `pay` / `miniprogram` / `website` / `scanLogin` / `officialAccount` / `work` / `http` 七段（`miniprogram` 与旧的显式 `miniProgram` 只差一个大小写）。
- `storage` tab：`storage.oss.endpoint` 是三层、但 `storage.driver` 只有两层 → 全或无规则下整 tab 平铺（符合预期，不会出现「driver 裸在外面」）。
- `attachments` / `smtp` / `develop`：全部两层 key → 平铺，行为不变。

### 注意点

- **key 命名从此带上语义**：三层 key 会被解释为分组，改名前要意识到这一点。
- 想给小 tab 也分组时，把 key 补成三层即可（例如 `smtp.relay.host`）；不想分组就别用三层。
- 显式 `section` 可继续用于例外情况（例如想让 `storage.oss.*` 与 `storage.driver` 同组，就显式写同一个 section）。

## 方案二：分组归属存 DB（热更新）

把归属关系放进一个配置项，运营在管理页改、30 秒内生效，**不用发版也不用重启**。

### 配置项

`src/modules/settings/settings.defaults.ts` 新增（`develop` 组）：

```ts
    {
        key: 'develop.settingSections',
        name: '配置项分组归属',
        group: 'develop',
        value: {},
        valueType: SettingValueType.JSON,
        description:
            '按 tab 覆盖配置项的二级分组，形如 { "wechat": { "wechat.pay.mchId": "pay" } }；留空则回退内置定义或按 key 推断。',
    },
```

### 运行时应用

在 `findAll` 里按 `DB 覆盖 > 显式定义 > key 推断` 的优先级应用：

```ts
        const overrides = await this.getJson<Record<string, Record<string, string>>>(
            'develop.settingSections',
            {},
        );
        return this.applySectionOverrides(this.deriveSections([...defaults, ...custom]), overrides);
```

`getJson` 复用现有的 30 秒缓存，所以改完最迟 30 秒生效。

### 代价

- 运营要手写 JSON，键写错会**静默不生效**（建议在 `update` 时校验 key 是否存在于 `SETTING_DEFINITION_MAP`，不合法直接 400）。
- 多一个需要解释的配置项，且它与「key 命名」这套约定并存，容易互相盖住。
- 只在「分组频繁调整、且不希望发版」时才值得。

## 方案三：搜索框（正交增强）

分组的真实目的是「找得到」，搜索能更直接地解决，且对所有 tab、以后所有新增项永久有效。

### 交互

tab 内容区顶部一个输入框，按 `key` / `name` / `description` 实时过滤；命中为 0 时显示空状态。

### 实现（约 30 行，纯前端）

`settings-presenter.ts` 把 `buildSections` 导出（当前是模块内私有），供页面重算：

```ts
export function buildSections(items: AdminSetting[]): SettingSection[] { /* 同上 */ }
```

`AdminSettingsView.vue`：

```ts
const keyword = ref('')

const visibleTabs = computed<SettingTab[]>(() => {
  const needle = keyword.value.trim().toLowerCase()
  if (!needle) return tabs.value
  return tabs.value.map((tab) => {
    const items = tab.items.filter((item) =>
      [item.key, item.name, item.description ?? ''].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    )
    return { ...tab, items, sections: buildSections(items) }
  })
})
```

模板里把 `v-for="tab in tabs"` 换成 `visibleTabs`；保存按钮仍走 `save(tab.key)` / `dirtyCount(tab.key)`，按 group 全量，**过滤只影响展示、不影响提交范围**。

### 注意点

- 过滤后某 tab 命中为 0，可只显示空状态而不是让 tab 消失（保留 tab 便于用户知道「是这个 tab 里没有」）。
- 与方案一、方案二都不冲突，可叠加。

## 对比

| | 以后加分组要做什么 | 是否要重启/发版 | 每加一项的成本 | 生效范围 |
| --- | --- | --- | --- | --- |
| 现状（显式 section） | 后端加字段 + 前端 2 处文案 | 要 | 高 | — |
| 方案一 1A（后端推断）✅ 已实施 | 起好三层 key | 一次性改动后不再需要 | **零** | 所有客户端 |
| 方案一 1B（前端推断） | 起好三层 key | 改一次前端 | **零** | 仅管理页 |
| 方案二（DB 配置） | 管理页改 JSON | 不用 | 低（易写错） | 所有客户端 |
| 方案三（搜索框） | 不需要分组 | 改一次前端 | 零 | 仅管理页 |

## 建议路线

1. **方案一 1A → 已实施**：`SettingsService.deriveSections` 按 key 第二段归类，`wechat` 的 26 处显式 `section` 已删除，之后新增 tab 零配置。
2. **方案三（搜索框）待定**：成本最低、改善「找得到」，与其余方案不冲突。
3. **方案二暂不实施**：除非出现「运营需要频繁调整分组且不愿发版」的真实需求；届时优先级链是 `DB 覆盖 > 显式定义 > key 推断`。

## 涉及文件

| 端 | 文件 | 方案涉及 |
| --- | --- | --- |
| 后端 | `src/modules/settings/settings.defaults.ts` | 一（已清理 26 处显式 section）、二（新增配置项） |
| 后端 | `src/modules/settings/settings.service.ts` | 一 1A、二 |
| 后端 | `src/modules/settings/settings.service.spec.ts` | 三个方案都要补断言 |
| 前端 | `src/utils/settings-presenter.ts` | 一 1B、三（导出 `buildSections`） |
| 前端 | `src/views/admin/AdminSettingsView.vue` | 一（文案映射可省）、三（搜索框） |
| 前端 | `src/locales/admin.zh-CN.ts`、`admin.en-US.ts` | 仅当需要中文/英文标题时 |
| 前端 | `test/unit/settings-presenter.spec.ts` | 一 1B、三 |

## 验证方式

```bash
# 后端（方案一 1A / 方案二）
cd D:/zuxcloud/nest-beacon
pnpm type-check && pnpm test -- src/modules/settings

# 前端（方案一 1B / 方案三）
cd D:/zuxcloud/Beacon/beacon-vue3
pnpm type-check && pnpm test:unit && pnpm lint
```

需要覆盖的断言：

- `wechat` tab 在**未声明 section** 时仍能得到 7 段（验证 key 推断）。
- `storage`（含两层 key）整 tab 平铺，不产生只含部分项的分组（验证全或无）。
- 显式 `section` 优先于 key 推断。
- 方案三：过滤后 `tab.items` 变化，但 `dirtyCount` / `saveGroup` 仍按 group 全量。
