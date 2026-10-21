/**
 * 生成小程序虚拟支付的道具图（默认 200×200 PNG，另存同名 SVG 便于再编辑）。
 *
 * 用法：
 *   pnpm assets:wechat-goods        # 200×200，MP 后台【道具管理】要求的尺寸
 *   pnpm assets:wechat-goods 600    # 需要大图时（同设计矢量放大，仍清晰）
 * 产物：`public/wechat-goods/{pro,team}-{month,quarter,year}.{png,svg}`
 *
 * 设计针对 200×200 重排过：只留「周期角标 + 套餐名 + 大号天数」。原来 600 版
 * 底部的说明文字在 200px 上会缩到 4~5px，纯糊，已去掉。
 *
 * 道具需要在 MP 后台【虚拟支付 → 道具管理】逐条上传，`item_url` 必须是**公网
 * 可访问**的 https 图片地址，因此生成后请把 PNG 传到自己的 CDN/对象存储，或者
 * 由后端把 `public/` 挂成静态目录。
 *
 * 价格刻意没有画进图片里——道具价格随时会调，画进去就得换图，而换图意味着微信
 * 侧要重新上传发布。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

interface PlanStyle {
    /** 文件名前缀，需与 MP 后台的道具 ID 前缀对应。 */
    key: 'pro' | 'team';
    /** 图片主标题。 */
    name: string;
    /** 主标题下的小字（英文，字距拉开）。 */
    plan: string;
    /**
     * 浅底上的显示色：`[深, 浅]` 同色相两档。
     *
     * 深色风格下用的米白端色（例如 #fff4db）放到白底上会直接消失，所以浅色
     * 主题单独给一组更实的同色相颜色，品牌色相不变。
     */
    ink: [string, string];
}

interface CycleStyle {
    /** 文件名后缀。 */
    key: 'month' | 'quarter' | 'year';
    /** 右上角标签文字。 */
    label: string;
    /** 有效期天数，与 `PlanTerm.durationDays` 一致。 */
    days: string;
}

const PLANS: PlanStyle[] = [
    {
        key: 'pro',
        name: '专业版',
        plan: 'PRO PLAN',
        ink: ['#9a6300', '#e0a92e'],
    },
    {
        key: 'team',
        name: '团队版',
        plan: 'TEAM PLAN',
        ink: ['#5b3ea8', '#8f6bef'],
    },
];

const CYCLES: CycleStyle[] = [
    { key: 'month', label: '月卡', days: '30' },
    { key: 'quarter', label: '季卡', days: '90' },
    { key: 'year', label: '年卡', days: '365' },
];

/**
 * 画布固定按 200×200 设计（与上传尺寸 1:1），要更大尺寸时由 `fitTo` 矢量放大。
 * 所有坐标都是 200 坐标系下的值。
 */
function svg(plan: PlanStyle, cycle: CycleStyle): string {
    const [deep, light] = plan.ink;
    // 三位数（365）比两位数宽，单字号会顶到边，按位数降一档。
    const dayFontSize = cycle.days.length >= 3 ? 64 : 76;

    return `<svg width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.6" stop-color="#f7fafd"/>
      <stop offset="1" stop-color="#eef3fa"/>
    </linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${deep}"/>
      <stop offset="1" stop-color="${light}"/>
    </linearGradient>
    <radialGradient id="glowTop" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${light}" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="${light}" stop-opacity="0.08"/>
      <stop offset="1" stop-color="${light}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowBottom" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#9dbde4" stop-opacity="0.36"/>
      <stop offset="1" stop-color="#9dbde4" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- 浅色渐变底 -->
  <rect width="200" height="200" fill="url(#bg)"/>
  <circle cx="178" cy="16" r="98" fill="url(#glowTop)"/>
  <circle cx="12" cy="206" r="112" fill="url(#glowBottom)"/>

  <!-- 品牌记号：三点信号格（呼应监控/探测，200px 下放不下完整字标） -->
  <g fill="url(#ink)">
    <circle cx="19" cy="27" r="1.6" fill-opacity="0.45"/>
    <circle cx="25" cy="27" r="2.1" fill-opacity="0.70"/>
    <circle cx="32" cy="27" r="2.6"/>
  </g>

  <!-- 右上角：周期标签（月卡 / 季卡 / 年卡） -->
  <g>
    <rect x="136" y="16" width="48" height="22" rx="11" fill="url(#ink)"/>
    <text x="160" y="31" text-anchor="middle" font-family="Microsoft YaHei" font-size="11" font-weight="700" fill="#ffffff">${cycle.label}</text>
  </g>

  <!-- 套餐名 -->
  <text x="18" y="69" font-family="Microsoft YaHei" font-size="26" font-weight="700" fill="#0f172a">${plan.name}</text>
  <text x="19" y="85" font-family="Microsoft YaHei" font-size="8" letter-spacing="3" fill="${deep}">${plan.plan}</text>

  <!-- 主体：大号有效期天数 -->
  <text x="100" y="152" text-anchor="middle" font-family="Microsoft YaHei" font-size="${dayFontSize}" font-weight="700" fill="url(#ink)">${cycle.days}</text>
  <text x="100" y="170" text-anchor="middle" font-family="Microsoft YaHei" font-size="12" letter-spacing="3" fill="#94a3b8">天</text>
</svg>`;
}

function main(): void {
    const requested = Number(process.argv[2] ?? 200);
    const size =
        Number.isFinite(requested) && requested >= 100 && requested <= 2000
            ? Math.round(requested)
            : 200;

    if (size !== 200) {
        console.log(
            `导出 ${size}px（上传仍以 200×200 为准，大图仅作素材/展示用）`,
        );
    }

    const outDir = resolve(process.cwd(), 'docs', 'images', 'wechat-goods');
    mkdirSync(outDir, { recursive: true });

    for (const plan of PLANS) {
        for (const cycle of CYCLES) {
            const source = svg(plan, cycle);
            const baseName = `${plan.key}-${cycle.key}`;

            // 留一份 SVG：改文字/配色时先改 SVG 再重跑，比对着图片调更快。
            writeFileSync(resolve(outDir, `${baseName}.svg`), source, 'utf8');

            const png = new Resvg(source, {
                fitTo: { mode: 'width', value: size },
                font: {
                    loadSystemFonts: true,
                    // 中文字体来自系统：Linux CI 上如需重生成，先装一套
                    // Noto Sans CJK 并把这里换成对应目录。
                    fontDirs: ['C:\\Windows\\Fonts'],
                    defaultFontFamily: 'Microsoft YaHei',
                },
            })
                .render()
                .asPng();

            writeFileSync(resolve(outDir, `${baseName}.png`), png);
            console.log(
                `${baseName}.png ${size}×${size} (${(png.length / 1024).toFixed(0)} KB)`,
            );
        }
    }

    console.log(`\nDone → ${outDir}`);
}

main();
