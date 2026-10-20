/**
 * 邮件版式使用的内置站点 Logo（源图：`src/modules/email/assets/beaconix.png`，
 * 184×50 PNG），这里以 data URI 形式内联进邮件 HTML。
 *
 * 为什么要内联：邮件客户端普遍会拦截外链图片，而本服务的生产镜像只打包
 * `dist`、不带 `views` 静态目录，`APP_WEB_URL` 又通常指向前端站点的域名，
 * 拼出来的图片地址会被拦或 404。内联图不依赖任何外部地址，QQ 邮箱 / Gmail /
 * Apple Mail 都能直接显示。
 *
 * 换成别的 Logo 有两种方式：
 * 1. 后台「系统设置 → 站点 Logo」填图片地址，会覆盖这里的默认值（Outlook
 *    桌面版不支持 data URI，走这条即可）；
 * 2. 直接替换 `assets/beaconix.png`，然后按下面命令重新生成本文件：
 *    node -e "const u='data:image/png;base64,'+require('fs').readFileSync('src/modules/email/assets/beaconix.png').toString('base64');console.log(JSON.stringify(u))"
 */
const BUILTIN_LOGO_CHUNKS = [
    'data:image/png;base64,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',
];

/** 内置 Logo 的 data URI，可直接作为 <img src> 使用 */
export const BUILTIN_LOGO_DATA_URI = BUILTIN_LOGO_CHUNKS.join('');
