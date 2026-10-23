# 探针（Probe Agent）打包与发布

本文件说明如何把 `probes/agent` 打成可分发产物、发布到下载源，以及安装器
（`install/install.sh`）与自更新（`self-update`）如何消费这些产物。

打包脚本：`probes/agent/scripts/build-release.js`（零依赖，Node ≥ 18，Windows /
macOS / Linux 通用，也可在 CI 里直接跑）。

```bash
pnpm probe:pack
# 等价于
node probes/agent/scripts/build-release.js
```

---

## 1. 发布物与消费方

产物名不是随便起的——仓库里已经有多处代码按固定名字、固定布局去取文件。唯一的发布布局是
**版本目录**：不可变产物放在 `<base>/<version>/`，根目录只留移动指针
（`latest.json`、`version.json`、`latest` 别名）与 `install.sh`。

```
https://get.beaconix.app/
├── install.sh                                   # 安装入口（桶根）
└── probe/                                       # 下载基址 = <base>
    ├── latest.json                              # 指针清单：最新稳定版
    ├── version.json                             # 发布历史
    ├── beaconix-probe-latest.tar.gz             # 兼容别名（仅 manifest 不可达时回退）
    └── <version>/
        ├── beaconix-probe-<version>.tar.gz      # 不可变产物
        ├── beaconix-probe-scf-<version>.zip
        ├── latest.json                          # 该版本的清单（自洽，可离线核对）
        └── SHA256SUMS
```

| 产物 | 谁消费 | 硬约束 |
| --- | --- | --- |
| `<version>/beaconix-probe-<version>.tar.gz` | `install/install.sh`、`docker-entrypoint.sh` | 解压后**根目录**必须是 `bin/`、`src/`…（安装器直接 `tar -xzf … -C /opt/beaconix-probe`，不剥前缀目录） |
| `beaconix-probe-latest.tar.gz` | `install.sh`（manifest 不可达时的回退） | 与最新稳定版 tar 字节级一致 |
| `<version>/beaconix-probe-scf-<version>.zip` | 腾讯云 SCF「上传代码包」 | 根目录含 `index.js`、`functions/scf.js` 与 `src/`；控制台 handler 填 `index.main` |
| `latest.json` | `install.sh`、`docker-entrypoint.sh`、`src/commands/self-update.js` | 至少含 `version`、`sha256`、`installUrl`；`tarball` 指向版本目录 |
| `<version>/latest.json` | 审计 / 离线核对 | 与该版本自洽；安装链路不读它 |
| `<version>/SHA256SUMS` | 安装器校验回退 | `sha256sum -c` 兼容格式（文件名相对该版本目录） |
| `SHA256SUMS` | 人工 / CI 校验 | 文件名相对下载根（`<version>/…`） |
| `install.sh` | 安装入口 `https://get.beaconix.app/install.sh` | 与 `probes/agent/install/install.sh` 完全一致 |
| `version.json` | 发布历史 / 审计页 | `{ updatedAt, versions: [...] }`，`tarball` 为相对下载根的路径 |

仓库内的 `probes/Dockerfile` 不产生新的发布物：它只是一个空镜像，容器首次启动时
由 `docker-entrypoint.sh` 按上表下载 tar.gz 并解压（见 §6.1）。

**三个不变量**（任一被破坏，线上安装或升级就会静默失败）：

1. **路径**：`<base>/<version>/beaconix-probe-<version>.tar.gz`。`$VERSION` 默认由
   `latest.json` 解析，也可以用 `install.sh --version` / `PROBE_VERSION` 显式指定。
2. **压缩包根布局**：`bin/beaconix-probe.js` 必须在归档根，且 `package.json`
   必须一起打包（`src/version.js` 通过 `require('../package.json')` 读版本）。
3. **`latest.json` 字段**：安装器（`install.sh` 与容器 entrypoint）用它解析
   `version` 与 `sha256`（以及作为回退的绝对 `tarball`），再下载不可变的版本化 tar；
   `self-update` 用 `version` 与 `installUrl`。`latest` 别名只作为兜底回退。

> `latest.json` 的其它字段（`layout`、`commit`、`sourceDate`、`scf`…）由脚本附加，
> 安装器会忽略，但对排查问题和做发布审计很有用。安装器请求 manifest 时带
> `?ts=<epoch>` 与 `cache-control: no-cache`，避免被 CDN 缓存钉住旧版本。

---

## 2. 版本规则

- **唯一版本来源**：`probes/agent/package.json` 的 `version`。运行时
  `src/version.js` 直接 `require` 它，所以归档里的 `package.json` 版本号就是
  `beaconix-probe --version` 的输出。
- **默认自动累加**：`pnpm probe:pack` 会把 patch 位 +1（例如 `2.1.1 -> 2.1.2`），
  写回 `package.json`，并把产物归档到 `probes/releases/<version>/`。
  - `--bump minor|major`：改累加位；
  - `--no-bump`：保持当前版本重打包；
  - `--version 2.2.0`：显式指定版本；
  - `pnpm probe:pack:scf` 默认**不**累加，避免只重打云函数包时版本上涨
    （需要时显式传 `--bump` 或 `--version`）。
- 发布流程：

  ```bash
  pnpm probe:pack                     # 自动 bump + 构建 + 归档
  git add probes/agent/package.json
  git commit -m "chore(probe): release 2.1.2"
  git tag probe-v2.1.2
  git push origin master --tags
  ```

- **预发布**（`2.1.0-beta.1`、`2.1.0-rc.1`）：脚本默认**不生成** `latest.json`
  和 `latest` 别名。预发布只能通过显式版本号安装：

  ```bash
  curl -fsSL https://get.beaconix.app/install.sh | sudo sh -s -- --version=2.1.0-beta.1
  ```

  需要强制让预发布占用 `latest` 时用 `--latest`（一般只在灰度环境这么做）。
- `--require-clean` 会在 `probes/agent` 有未提交改动时直接失败；它在 bump 之前检查，
  所以正式发布可以带上。bump 会修改 `package.json`，发布后记得一起提交。
- 容器启动时通过 `latest.json` 解析当前版本并拉取对应的版本化 tar，所以升版本后
  无需手动清卷。

---

## 3. 打包

```bash
# 稳定版发布
node probes/agent/scripts/build-release.js --require-clean

# 只出本地产物、不生成 latest 别名（预发布 / 私有化交付）
node probes/agent/scripts/build-release.js --no-latest

# 自定义下载源（默认 https://get.beaconix.app/probe）
node probes/agent/scripts/build-release.js --base-url https://cdn.example.com/probe

# 不构建 SCF 包
node probes/agent/scripts/build-release.js --no-scf

# 只构建 SCF 代码包（不清空、不覆盖 dist 里的其它发布物）
pnpm probe:pack:scf
# 等价于 node probes/agent/scripts/build-release.js --scf-only
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--out <dir>` | `probes/agent/dist` | 输出目录（每次构建会先清空，已加进 `.gitignore`） |
| `--releases-dir <dir>` | `probes/releases` | 版本归档目录，每个版本一个子目录 |
| `--no-archive` | 关 | 只写版本索引，不复制产物到 `releases/` |
| `--bump <part>` | `patch` | 自动累加 `package.json`：`patch` / `minor` / `major` |
| `--no-bump` | 关 | 保持当前版本重打包 |
| `--version <x.y.z>` | — | 显式指定版本（优先于 bump） |
| `--base-url <url>` | `https://get.beaconix.app/probe` | 写进 `latest.json` 的 tarball 地址前缀 |
| `--install-url <url>` | `https://get.beaconix.app/install.sh` | 写进 `latest.json` 的安装脚本地址 |
| `--no-scf` | 构建 | 跳过腾讯云 SCF zip |
| `--scf-only` | 关 | 只生成 SCF zip，保留 `dist` 里其它已有产物 |
| `--latest` / `--no-latest` | 稳定版生成 | 强制开 / 关 `latest` 别名与 `latest.json` |
| `--require-clean` | 关 | `probes/agent` 有未提交改动时报错 |
| `--no-verify` | 关 | 跳过构建后的归档校验（不建议） |

输出示例：

```
Beacon probe agent 2.1.2 (latest, 3f0c5b3)
Version: 2.1.1 -> 2.1.2
Output: probes/agent/dist
Archive: probes/releases/2.1.2

  2.1.2/beaconix-probe-2.1.2.tar.gz    23.5 KiB
  beaconix-probe-latest.tar.gz         23.5 KiB
  2.1.2/beaconix-probe-scf-2.1.2.zip   31.0 KiB
  install.sh                           8.6 KiB
  latest.json                          pointer to this version
  2.1.2/SHA256SUMS                     version-local checksums
  2.1.2/latest.json                    manifest describing this version
  SHA256SUMS                           root checksums (paths from the root)
  version.json                         history (2 version(s))

Upload the output directory as-is so that it resolves as:
  rclone copy probes/agent/dist/ r2:<bucket>/probe/
  rclone copy probes/agent/dist/install.sh r2:<bucket>/
```

只重打包当前版本、不累加：

```bash
pnpm probe:pack -- --no-bump
```

### 构建后自动校验

默认（`--no-verify` 可关）脚本会：

1. 把 tar.gz 解压到临时目录，确认 `bin/beaconix-probe.js`、`package.json` 存在；
2. 对归档里每个 `.js` 执行 `node --check`（语法级回归）；
3. 直接运行解压出来的 CLI 的 `version`，比对是否等于 `package.json` 的版本；
4. 把生成的 SCF zip 解析回来，逐条校验 CRC 与解压后长度（保证上传到云厂商不会坏包）；
5. 检查 `install.sh` 仍在按 `<base>/<version>/beaconix-probe-<version>.tar.gz` 下载
   （防止契约漂移），同时确认它仍在解析 `latest.json`。

> 校验第 1 步需要系统里有 `tar`。没有 `tar` 时只跳过这一步并打印 warning，其余检查照常。

---

## 4. 产物内部布局

### 4.1 探针 tar.gz

```
RELEASE.json                      # 版本 / commit / 源码时间 / engines
bin/beaconix-probe.js             # 0755，CLI 入口
src/...                           # 全部运行时代码
index.js                          # SCF 根入口（exports.main）
functions/scf.js                  # 单次执行实现（require('../src/...')）
install/install.sh                # 安装脚本本身
install/beacon-probe.service.tpl  # systemd unit 模板
package.json                      # 版本来源，必须存在
```

不包含 `test/`、`dist/`、`scripts/`、`node_modules/`——探针运行时零依赖，
安装目录只保留运行所需文件。

### 4.2 SCF zip

```bash
pnpm probe:pack:scf
# → probes/agent/dist/<version>/beaconix-probe-scf-<version>.zip
```

```
index.js
functions/scf.js
src/...
package.json
RELEASE.json
```

`index.js` 是根入口，导出 `main`（`exports.main = async (event, context) => …`），
内部 `require('./functions/scf')`。`functions/scf.js` 用的是 `require('../src/...')`，
所以 zip 必须保留 `functions/` 这层目录，**不能**把 `scf.js` 挪到根目录。
控制台 handler 填 `index.main`；环境变量见
[云函数部署指南](../docs/guides/probe-scf-deployment.md)（`/docs` 为本地文档，未纳入版本库）。

腾讯云控制台新建函数时的关键配置：

| 项 | 值 |
| --- | --- |
| 运行环境 | Node.js 18 / 20 / 22 |
| 提交方式 | 上传代码包（`beaconix-probe-scf-<version>.zip`） |
| 执行方法（handler） | `index.main` |
| 环境变量 | `BEACON_API_URL`、`PROBE_KEY`、`PROBE_TOKEN`、`PROBE_INTERVAL_SECONDS` |
| 定时触发器 | 周期必须等于 `PROBE_INTERVAL_SECONDS`（否则会被判离线） |
| 超时 | 大于 `PROBE_TIMEOUT_MS`，建议 ≥ 30s |

更新函数时重新 `pnpm probe:pack:scf` 并上传覆盖即可；凭据在环境变量里，不受影响。

### 4.3 `latest.json`

根 `latest.json` 是**指针**，`<version>/latest.json` 是同一份内容但只描述该版本：

```json
{
    "name": "@beaconix/probe-agent",
    "version": "2.1.2",
    "channel": "latest",
    "layout": "versioned",
    "tarball": "https://get.beaconix.app/probe/2.1.2/beaconix-probe-2.1.2.tar.gz",
    "installUrl": "https://get.beaconix.app/install.sh",
    "sha256": "<tar.gz 的 sha256>",
    "engines": { "node": ">=18" },
    "commit": "fde31d2",
    "sourceDate": "2026-10-16T01:08:28+08:00",
    "latestTarball": "https://get.beaconix.app/probe/beaconix-probe-latest.tar.gz",
    "scf": {
        "tarball": "https://get.beaconix.app/probe/2.1.2/beaconix-probe-scf-2.1.2.zip",
        "handler": "index.main"
    }
}
```

- `layout` 恒为 `versioned`，记录发布布局；安装器不依赖它，只用于排查与校验。
- `tarball` / `scf.tarball` 是绝对地址，但安装器**先按 `BEACON_DOWNLOAD_BASE` 拼版本目录**，
  拿不到才用 manifest 里的绝对地址——镜像部署不会被拉回官方域名。
- 预发布（`2.1.2-beta.1`）不写根 `latest.json`，但版本目录里仍然有 `<version>/latest.json`。

构建是可复现的：归档内所有时间戳取自 git 提交时间（`sourceDate`），不写构建
机器的当前时间；同样的提交 + 同样的版本号会得到同样的字节。

### 4.4 `version.json` 与 `probes/releases/`

每次 `pnpm probe:pack` 会：

1. 读取 `probes/releases/version.json`（首次打包时从 `dist/version.json` 迁移）；
2. 累加/更新当前版本条目；
3. 写回 `probes/releases/version.json` 和 `dist/version.json`；
4. 把本次产物复制到 `probes/releases/<version>/`。

```json
{
    "updatedAt": "2026-10-19T09:45:05Z",
    "versions": [
        {
            "version": "2.1.2",
            "releasedAt": "2026-10-19T09:45:05Z",
            "channel": "latest",
            "commit": "3f0c5b3",
            "sourceDate": "2026-10-18T23:03:48+08:00",
            "tarball": "2.1.2/beaconix-probe-2.1.2.tar.gz",
            "sha256": "f30d0c17…",
            "size": 24059,
            "scf": {
                "tarball": "2.1.2/beaconix-probe-scf-2.1.2.zip",
                "handler": "index.main",
                "sha256": "35bbe49a…",
                "size": 31722
            }
        }
    ]
}
```

`tarball` / `scf.tarball` 是**相对下载根**的路径，和根 `SHA256SUMS` 里的写法一致。

归档目录（`probes/releases/<version>/`，天然自洽的一份快照）：

```
probes/releases/2.1.2/
├── beaconix-probe-2.1.2.tar.gz
├── beaconix-probe-scf-2.1.2.zip
├── beaconix-probe-latest.tar.gz
├── latest.json
├── SHA256SUMS
├── install.sh
└── version.json
```

- `versions` **最新在前**；同一版本重复打包会替换该条目，不会重复追加。
- `releasedAt` 保留首次记录时间，`updatedAt` 是最近一次 pack 的时间。
- `--no-archive` 只写版本索引，不复制产物；`--releases-dir` 可改归档位置。
- `pnpm probe:pack:scf` 只更新该版本的 `scf` 字段，并把新 zip 复制到已有归档目录。
- `.gitignore` 忽略 `probes/releases/*/`（二进制不入库），但保留
  `probes/releases/version.json`，版本索引可以提交。
- `dist/version.json` 是给 CDN 上传的副本；清理 `dist` 不会丢历史（历史在
  `probes/releases/version.json`）。
- `version.json` **不参与安装链路**，缺失不影响 `install.sh` 或容器启动。

---

## 5. 发布到下载源

### 一键同步（推荐）

```bash
pnpm probe:pack      # 构建：自动 bump + 归档到 probes/releases/<version>/
pnpm probe:publish   # 上传：顺序、缓存头、幂等、上传后校验都内置
pnpm probe:verify    # 线上校验
```

`publish-release.js` 直接走 S3 API（项目已依赖 `@aws-sdk/client-s3`，无需装 rclone / aws CLI）：

| 变量 | 说明 |
| --- | --- |
| `PROBE_R2_ENDPOINT` | R2 的 S3 endpoint，形如 `https://<accountid>.r2.cloudflarestorage.com` |
| `PROBE_R2_BUCKET` | 发布桶（**必填**） |
| `PROBE_R2_ACCESS_KEY_ID` / `PROBE_R2_SECRET_ACCESS_KEY` | R2 令牌 |
| `PROBE_R2_REGION` | 默认 `auto` |
| `PROBE_R2_PREFIX` | 默认 `probe` |
| `PROBE_R2_FORCE_PATH_STYLE` | MinIO / 自建 S3 时设 `1` |

- 变量可放 `.env`（脚本会自动加载仓库根 `.env`），也可用 `--env-file` 指定。
- 回退到 `STORAGE_OSS_*` 时必须显式加 `--allow-storage-bucket`，防止把发布物传进附件桶。
- 常用参数：`--dry-run`（只打印计划）、`--force`（重传 immutable 产物）、`--version 2.1.2`（只传某版本）、`--no-installer`、`--install-key <key>`。
- **上传顺序**：版本目录 → `version.json` → `latest.json` → `latest` 别名 → `install.sh`。中途失败时线上仍指向旧版本，可直接重跑。
- **幂等**：`<version>/**` 大小一致就跳过；指针类（`latest.json`、`version.json`、`install.sh`、别名）每次都重传。
- **上传后校验**：逐个 HeadObject 比对大小，失败即非零退出（`--no-verify` 可跳过）。

行为示例：

```
Publishing probes/agent/dist -> s3://beaconix/probe
Versions: 2.1.2

  = probe/2.1.2/beaconix-probe-2.1.2.tar.gz    24.3 KiB  unchanged
  + probe/version.json                          734 B  public, max-age=60, must-revalidate
  + probe/latest.json                           681 B  public, max-age=60, must-revalidate
  + probe/beaconix-probe-latest.tar.gz        24.3 KiB  public, max-age=300
  + install.sh (bucket root)                  10.9 KiB  public, max-age=60, must-revalidate

Done: 4 uploaded, 4 unchanged
Verified 8 object(s) with HeadObject.
```

### 手工同步（rclone / aws cli）

`probes/agent/dist/` 已经就是下载根的镜像，整目录同步即可：

```bash
rclone copy probes/agent/dist/ r2:beaconix/probe/      # 版本目录 + 根指针
rclone copy probes/agent/dist/install.sh r2:beaconix/   # 入口脚本在桶根
```

| 本地产物 | 线上 URL | 缓存策略 |
| --- | --- | --- |
| `2.1.2/beaconix-probe-2.1.2.tar.gz` | `https://get.beaconix.app/probe/2.1.2/beaconix-probe-2.1.2.tar.gz` | 长缓存（`max-age=31536000, immutable`），版本目录内容永不改写 |
| `2.1.2/beaconix-probe-scf-2.1.2.zip` | `https://get.beaconix.app/probe/2.1.2/beaconix-probe-scf-2.1.2.zip` | 长缓存（同上） |
| `2.1.2/latest.json` | `https://get.beaconix.app/probe/2.1.2/latest.json` | 长缓存（该版本自洽，安装链路不读） |
| `2.1.2/SHA256SUMS` | `https://get.beaconix.app/probe/2.1.2/SHA256SUMS` | 长缓存 |
| `beaconix-probe-latest.tar.gz` | `https://get.beaconix.app/probe/beaconix-probe-latest.tar.gz` | 短缓存；**只作为 manifest 不可达时的回退**，缓存旧了不影响安装 |
| `latest.json` | `https://get.beaconix.app/probe/latest.json` | **必须短缓存**（60s 或 no-cache）；安装器带 `?ts=` 主动绕过缓存 |
| `SHA256SUMS` | `https://get.beaconix.app/probe/SHA256SUMS` | 短缓存（路径相对下载根） |
| `version.json` | `https://get.beaconix.app/probe/version.json` | 短缓存（发布历史，非安装依赖） |
| `install.sh` | `https://get.beaconix.app/install.sh` | 短缓存（它是入口脚本，改一次要尽快生效） |

**上传顺序**：版本目录产物 → `<version>/SHA256SUMS` → `<version>/latest.json` →
`version.json` → 根 `latest.json` → `latest` 别名 → `install.sh`。
安装链路只依赖版本目录与根 `latest.json`；别名属于回退路径，晚传不影响新安装。

发布后校验：

```bash
pnpm probe:verify
# 等价于 node probes/agent/scripts/verify-release.js [--base-url <url>]

# 手工检查也可以：
curl -fsSL https://get.beaconix.app/probe/latest.json | head -20
curl -fsSL https://get.beaconix.app/probe/SHA256SUMS | sha256sum -c --ignore-missing
```

`verify-release.js` 的判定：

| 检查 | 级别 | 说明 |
| --- | --- | --- |
| `latest.json` 的 `version` / `sha256` / `installUrl` | FAIL | 安装器解析入口 |
| `<version>/beaconix-probe-<version>.tar.gz` 存在 + sha256 + 归档内版本 | FAIL | 实际安装的包 |
| `<version>/latest.json` 与根清单的 version/sha256 一致 | FAIL | 版本目录自洽 |
| `<version>/SHA256SUMS` 列出且匹配 tar / scf zip | FAIL | 安装器校验回退 |
| SCF zip、`install.sh` 是否按 `<base>/<version>/…` 下载 | FAIL | 其它分发通道 |
| `latest.json` 的 `tarball` 与实际发布布局一致 | **WARN** | 安装器按 base 优先解析，不一致也能装 |
| `beaconix-probe-latest.tar.gz` 字节一致、`version.json` 条目 | **WARN** | 仅回退 / 审计路径 |

历史上「新 tar 和 `latest.json` 都传了、别名被 CDN 缓存住」会让整批新装机器停在旧版本；
现在安装器先按版本目录取包，这种情况只会得到一条 WARN。

### 5.1 回滚

只改 `probe/latest.json`（必要时连 `version.json`）指回旧版本即可，产物不用重传：

```bash
rclone copy probes/releases/2.1.1/latest.json r2:beaconix/probe/latest.json
# 需要连别名一起回退时：
rclone copy probes/releases/2.1.1/beaconix-probe-2.1.1.tar.gz \
    r2:beaconix/probe/beaconix-probe-latest.tar.gz
```

清理旧版本时删掉 `probe/<version>/` 一个目录即可。

---

## 6. 安装 / 升级链路

```
用户机器                                CDN                                    Beacon API
   │  curl install.sh                      │                                        │
   ├─────────────────────────────────────▶│                                        │
   │  GET /probe/latest.json?ts=…          │                                        │
   ├─────────────────────────────────────▶│                                        │
   │  GET /probe/<version>/beaconix-probe-<version>.tar.gz                          │
   ├─────────────────────────────────────▶│                                        │
   │  （版本目录 404 时回退：manifest 绝对地址 → latest 别名）                        │
   │  sha256 校验（manifest 或 <version>/SHA256SUMS） → 解压到 /opt/beaconix-probe   │
   │  建 beaconix 用户 + systemd unit      │                                        │
   │  systemctl start → beaconix-probe run │                                        │
   │                                        │                                        │
   │  首次启动无凭据 → POST /probes/enroll/device                                   │
   ├──────────────────────────────────────────────────────────────────────────────▶│
   │  打印 Open: <approval URL> / Code: XXXX-XXXX                                   │
   │  用户在浏览器确认 → POST /probes/enroll/approve（JWT + ADMIN）                  │
   ├──────────────────────────────────────────────────────────────────────────────▶│
   │  轮询 POST /probes/enroll/token → approved → 凭据写 /etc/beaconix/probe.json   │
   ├──────────────────────────────────────────────────────────────────────────────▶│
   │  正常业务：POST /probes/heartbeat 拉监控 → 执行检查 → 上报结果                  │
   │                                        │                                        │
   │  之后每次 `self-update --check`:        │                                        │
   │  GET /probe/latest.json               │                                        │
   ├─────────────────────────────────────▶│                                        │
   │  latest.version != 本地 VERSION → 打印  │                                        │
   │  `curl -fsSL <installUrl> | sudo sh -s -- --version=<latest>`                  │
```

要点：

- `install.sh` 默认**只安装**（`--token` 直接注册，`--login` 安装时登录）；授权由首次
  `run` 自动发起，链接进 journal：`journalctl -u beaconix-probe -f`。
- `self-update` **不会**自己覆盖 `/opt` 下的文件（需要 root），它只负责比对版本并
  打印升级命令；真正的替换由 `install.sh` 完成（`install.sh` 可重复执行，等于原地升级）。
- `install.sh` 的下载源可用 `BEACON_DOWNLOAD_BASE` 覆盖；API 地址默认
  `https://beaconix.app/api`，可用 `--api-url` / `BEACON_API_URL` 覆盖，并写进
  `/etc/beaconix/probe.env`（unit 的 `EnvironmentFile=-`，之前的版本不写这个
  文件，导致首次 `run` 落回 agent 内置的 `http://localhost:3000/api` 并被
  preflight 拒绝）。`probe.env` 里已有的地址在重装时保留，除非显式传了
  `--api-url`/`BEACON_API_URL`，其它键也不会被覆盖。
- systemd unit 由 `install.sh` 生成，`ExecStart=<node> /opt/beaconix-probe/bin/beaconix-probe.js run`，
  所以升级只要替换 `/opt/beaconix-probe` 内容并 `systemctl restart`，unit 无需改。
- Web「添加探针」生成的命令与设备码返回的激活页来自后端，不是前端写死：
  `ProbeEndpointsService` 先读管理页「探针」分组的 `probe.endpoint.publicApiUrl` /
  `probe.endpoint.activateUrl` / `probe.endpoint.installUrl`（SUPER_ADMIN 可改），留空
  回退 `BEACON_PUBLIC_API_URL` / `BEACON_ACTIVATE_URL` / `BEACON_INSTALL_URL`，最后落到
  `https://beaconix.app/api`、`https://beaconix.app/activate`、
  `https://get.beaconix.app/install.sh`。私有化部署改这三项即可，无需改代码。

### 6.1 容器形态（`probes/Dockerfile`）

镜像本身**不含 agent 代码**：容器首次启动时由 `probes/docker-entrypoint.sh`
按与 `install.sh` 相同的解析链把已发布产物下载到 `/data/agent`（版本目录 →
manifest 绝对地址 → `latest` 别名），然后交给 `run`；`run` 发现没有凭据
就自动发起设备码授权，把验证链接和用户码打到 `docker logs`，批准后自动进入正常业务。
之后重启复用 `/data` 卷里的安装和凭据，不再下载、不再登录。

```bash
docker build -f probes/Dockerfile -t beacon-probe probes

docker run -d --name beacon-probe --restart unless-stopped \
  -e BEACON_API_URL=https://api.example.com/api \
  -v beacon-probe-data:/data \
  beacon-probe

docker logs -f beacon-probe
```

首次启动的日志大致如下（`Open:` 就是登录地址）：

```
[probe] installing beacon probe agent (latest) from https://get.beaconix.app/probe
[probe] installed to /data/agent (2.0.0)
[2026-10-17T…Z] No probe credential found; starting device authorization (the URL below expires in about 10 minutes)
[2026-10-17T…Z] Requesting access for <host> (linux) ...
[2026-10-17T…Z] Open:  https://app.example.com/activate?code=ABCD-1234
[2026-10-17T…Z] Code:  ABCD-1234
[2026-10-17T…Z] Waiting for approval ...
[2026-10-17T…Z] Enrollment approved: probe=<id>
[2026-10-17T…Z] Credentials saved to /data/etc/probe.json
[2026-10-17T…Z] Probe agent started: probe=<id> heartbeat=60s ...
[2026-10-17T…Z] Heartbeat OK: probe=<id> status=ONLINE monitors=…
```

用 Compose（`probes/agent/docker-compose.yml`）：

```bash
cd probes/agent
cp probe.env.example probe.env        # 只需填 BEACON_API_URL
docker compose --env-file probe.env up -d --build
docker compose --env-file probe.env logs -f
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BEACON_API_URL` | `https://beaconix.app/api`（compose） | 后台 API；生产必须 https |
| `PROBE_ENROLL_TOKEN` | 空 | 用 Web 下发的一次性 token 代替设备码登录 |
| `PROBE_VERSION` | `latest` | 指定要下载的发布版本 |
| `BEACON_DOWNLOAD_BASE` | `https://get.beaconix.app/probe` | 下载源（内网镜像 / 本机 dist） |
| `PROBE_AUTO_UPDATE` | `1` | 每次启动重新下载；`0` 复用卷里已安装的版本 |
| `PROBE_FORCE_INSTALL` | `0` | 无视 `PROBE_AUTO_UPDATE=0` 强制重下（凭据保留） |

其他行为：

- **持久化**：`/data`（安装 `/data/agent`、凭据 `/data/etc/probe.json`）。不挂卷，
  容器重建后要重新登录。
- **安装与升级**：每次启动先读 `<base>/latest.json?ts=…` 拿到 `version` / `sha256`，
  再下载不可变的 `beaconix-probe-<version>.tar.gz`，校验 sha256 后解压到暂存目录
  再整体替换；manifest 不可达时回退 `latest` 别名，下载或校验失败则保留已安装版本
  继续运行。因此发布新包后 `docker compose up -d --build`（或 `restart`）就会生效，
  **CDN 缓存了 `latest` 别名也不会钉住旧版本**。想固定当前版本用
  `PROBE_AUTO_UPDATE=0` 或 `PROBE_VERSION=2.1.0`。
- **不要 publish 端口**：探针纯出站。
- **没有 healthcheck**：没有本地端点，以后台「最后心跳」为准。
- **优雅退出**：entrypoint 用 `exec` 启动 `run`，`SIGTERM` 直达 node；compose
  给了 20s 宽限。
- **透传子命令**：`docker run --rm ... beacon-probe validate`（或 `run --once`、
  `status`）会跳过登录直接执行。
- **登录失败**（拒绝/超时）容器退出，`docker start` 重新出码即可。
- **升级**：发布新版本到下载源后，`docker compose up -d --build`（或 `restart`）
  即可——启动时会重新拉取 `latest` 并替换卷里的 payload，凭据保留。

---

## 7. 回滚

产物按版本号不可变，回滚 = 把「可变指针」指回旧版本：

1. 把旧版本的 tar.gz 重新上传为 `beaconix-probe-latest.tar.gz`（或直接把旧版本文件重新 copy 到别名）；
2. 用旧版本内容重新生成并上传 `latest.json`（`version` 改成旧版本号）；
3. 已安装的探针执行 `self-update --check` 会提示可升级到旧版本，按提示执行
   `install.sh --version=<旧版本>` 即可。

建议保留最近 5～10 个版本的 tar.gz 与 zip，`latest.json` 里也可以临时把
`channel` 标成 `rollback` 方便审计。

---

## 8. CI 自动化（示例，未写入 `ci.yml`）

`.github/workflows/ci.yml` 目前只跑后端类型检查 / lint / 单测 / 构建。发布探针建议
另开一个只在 tag 上触发的 workflow，核心步骤：

```yaml
name: release-probe

on:
  push:
    tags: ['probe-v*']

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Test agent
        run: node --test "probes/agent/test/*.test.js"
      - name: Build artifacts
        run: node probes/agent/scripts/build-release.js --require-clean
      - name: Upload to object storage
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          AWS_ENDPOINT_URL: ${{ secrets.R2_ENDPOINT }}
        run: |
          aws s3 cp probes/agent/dist/2.1.2/ s3://beaconix/probe/2.1.2/ --recursive
          aws s3 cp probes/agent/dist/version.json s3://beaconix/probe/
          aws s3 cp probes/agent/dist/latest.json s3://beaconix/probe/
          aws s3 cp probes/agent/dist/SHA256SUMS s3://beaconix/probe/
          aws s3 cp probes/agent/dist/beaconix-probe-latest.tar.gz s3://beaconix/probe/
          aws s3 cp probes/agent/dist/beaconix-probe-2.1.2.tar.gz s3://beaconix/probe/
          aws s3 cp probes/agent/dist/install.sh s3://beaconix/
```

注意：CI 里版本号仍来自 `probes/agent/package.json`，tag 只用于触发；发布前确保
tag 版本与 `package.json` 一致（可在 step 里加一条断言）。

---

## 9. 待加固项（当前尚未实现）

- **完整性校验已就位，但只覆盖 tar.gz**：`install.sh` 与容器 entrypoint 会用
  `latest.json.sha256`（或 `<version>/SHA256SUMS`）校验下载包，失败即退出；`install.sh`
  本身没有签名（见下一条）。
- **没有签名**：产物可被下载源篡改。若要防供应链攻击，可加 minisign/cosign 签名，
  并在 `install.sh` 里验签。
- **依赖宿主机 Node**：`install.sh` 要求目标机已装 Node ≥ 18（可用
  `BEACON_NODE_BIN` 指定；家目录下的 nvm/fnm node 因 unit 的 `ProtectHome=true`
  只能配合 `--no-service` 手动运行）。若想完全自包含，可另出一个 Node SEA /
  单文件可执行产物的发布通道（当前 `--no-scf` 之类的开关不影响主链路）。
- **SCF zip 未在真实云函数环境做冒烟**：本地已做 zip 结构与 CRC 校验，但触发器周期与
  `PROBE_INTERVAL_SECONDS` 必须相等这一约束只能部署后验证。

---

## 10. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `install.sh` 报 `tar: … not found in archive` 或装完 `/opt/beaconix-probe/bin` 不存在 | tar.gz 里多了一层顶层目录 | 归档根必须是 `bin/`，重新用 `build-release.js` 打包 |
| `self-update` 报 `Update manifest … returned HTTP 404` | `latest.json` 未上传或路径不在 `base` 下 | 确认默认 base 是 `…/probe`，manifest 就在该目录 |
| `self-update` 长期显示「Up to date」但已发新版 | CDN 缓存了 `latest.json` | 给 `latest.json` 设 60s / no-cache 并刷新缓存 |
| `self-update` 报 `missing a version` | manifest 被手工改坏 | 用脚本重新生成，不要手写 |
| 服务 5 秒一次重启，日志 `Insecure API URL "http://localhost:3000/api"` | `/etc/beaconix/probe.env` 缺 `BEACON_API_URL`（老安装器不写该文件，agent 落回内置开发默认值） | `printf 'BEACON_API_URL=https://beaconix.app/api\n' \| sudo tee /etc/beaconix/probe.env` 后 `sudo systemctl restart beaconix-probe`；新版 `install.sh` 会自动写 |
| 安装后 `beaconix-probe: command not found` | `/usr/local/bin/beaconix-probe` 这个 wrapper 没生成（通常是脚本中途失败） | 重跑 `install.sh`；检查 `/usr/local/bin` 是否在 PATH |
| SCF 报 `Cannot find module './functions/scf'` 或 `../src/config` | zip 里缺了 `index.js` 或 `functions/` 目录 | 重新 `pnpm probe:pack:scf` 上传；保持 `index.js` + `functions/scf.js` + `src/` 布局，handler 用 `index.main` |
| SCF 探针频繁 OFFLINE | 触发器周期 ≠ `PROBE_INTERVAL_SECONDS` | 两者必须相等，按部署指南设置 |
| 容器日志出现 `curl: (22) … 404` / `curl: (6) Could not resolve host` | 下载源不可达，或该版本文件不存在 | 检查 `BEACON_DOWNLOAD_BASE` 与 `PROBE_VERSION`（预发布不写根 `latest.json`） |
| 容器重建后又要求登录 | `/data` 没挂持久卷 | `-v beacon-probe-data:/data`（compose 已配命名卷） |
| 容器每次安装后还是旧版本（日志显示 `installed to … (2.0.0)`） | `latest.json` 被 CDN 缓存成旧版本，或下载源缺少对应的版本目录 | 安装器已带 `?ts=` 绕过缓存并优先按版本目录取包；确认 `pnpm probe:verify` 为全 OK，必要时手动刷新 `latest.json` 缓存 |
| 安装日志出现 `is unavailable; trying the next source` 但最终成功 | 该来源缺失（版本目录 / manifest 绝对地址 / 别名其中之一） | 正常回退；若最终装到的版本不对，跑 `pnpm probe:verify` 定位缺失产物 |
| 容器日志 `Missing probe credential(s)` | 未登录就用透传子命令跑了 `run` | 先不带参数启动完成登录，或设置 `PROBE_ENROLL_TOKEN` |
| `run` 长时间停在 `Waiting for approval` | 网页上还没确认，或链接已过期（10 分钟） | 重新打开链接；过期后进程退出，systemd / restart 策略会重新出码 |

本地调试打包与安装流程：

```bash
# 1. 出包（不依赖网络）
pnpm probe:pack

# 2. 起一个本地静态服务器模拟 CDN（任意静态服务器均可）
cd probes/agent/dist && python3 -m http.server 8080   # 或 npx serve .

# 3. 用本地源跑自更新检查
BEACON_DOWNLOAD_BASE=http://127.0.0.1:8080 \
  node probes/agent/bin/beaconix-probe.js self-update --check

# 4. 模拟 install.sh 的下载 + 解压（不需要 root）
mkdir -p /tmp/probe-install && \
  curl -fsSL http://127.0.0.1:8080/beaconix-probe-latest.tar.gz -o /tmp/probe-install/agent.tgz && \
  tar -xzf /tmp/probe-install/agent.tgz -C /tmp/probe-install && \
  node /tmp/probe-install/bin/beaconix-probe.js version
```
