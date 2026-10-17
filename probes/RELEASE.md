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

产物名不是随便起的——仓库里已经有两处代码按固定名字、固定布局去取文件：

| 产物 | 谁消费 | 硬约束 |
| --- | --- | --- |
| `beaconix-probe-<version>.tar.gz` | `install/install.sh --version <v>` | 解压后**根目录**必须是 `bin/`、`src/`…（`install.sh` 直接 `tar -xzf … -C /opt/beaconix-probe`，不剥前缀目录） |
| `beaconix-probe-latest.tar.gz` | `install.sh` 默认路径（`VERSION=latest`） | 与 `beaconix-probe-<version>.tar.gz` 字节级一致 |
| `beaconix-probe-scf-<version>.zip` | 腾讯云 SCF「上传代码包」 | 根目录含 `functions/scf.js` 与 `src/`；控制台 handler 填 `functions/scf.main_handler` |
| `latest.json` | `src/commands/self-update.js` | 至少含 `version`、`installUrl`；缺失则 `self-update` 直接报错 |
| `install.sh` | 安装入口 `https://get.beaconix.app/install.sh` | 与 `probes/agent/install/install.sh` 完全一致 |
| `SHA256SUMS` | 人工 / CI 校验 | `sha256sum -c` 兼容格式 |

仓库内的 `probes/Dockerfile` 不产生新的发布物：它只是一个空镜像，容器首次启动时
由 `docker-entrypoint.sh` 按上表下载 tar.gz 并解压（见 §6.1）。

**三个不变量**（任一被破坏，线上安装或升级就会静默失败）：

1. **文件名**：`beaconix-probe-$VERSION.tar.gz`，其中 `$VERSION` 是用户传给
   `install.sh --version` 的值，默认 `latest`。
2. **压缩包根布局**：`bin/beaconix-probe.js` 必须在归档根，且 `package.json`
   必须一起打包（`src/version.js` 通过 `require('../package.json')` 读版本）。
3. **`latest.json` 字段**：`version` 用于与本地 `VERSION` 比较（不等即提示有更新），
   `installUrl` 用于拼出升级命令。

> `latest.json` 的其它字段（`sha256`、`commit`、`sourceDate`、`scf`…）由脚本附加，
> `self-update` 会忽略，但对排查问题和做发布审计很有用。

---

## 2. 版本规则

- **唯一版本来源**：`probes/agent/package.json` 的 `version`。运行时
  `src/version.js` 直接 `require` 它，所以归档里的 `package.json` 版本号就是
  `beaconix-probe --version` 的输出。
- 发布前先改版本号、提交，再打 tag：

  ```bash
  # 修改 probes/agent/package.json 的 version，然后：
  git commit -am "chore(probe): release 2.0.0"
  git tag probe-v2.0.0
  git push origin master --tags
  ```

- **预发布**（`2.1.0-beta.1`、`2.1.0-rc.1`）：脚本默认**不生成** `latest.json`
  和 `latest` 别名。预发布只能通过显式版本号安装：

  ```bash
  curl -fsSL https://get.beaconix.app/install.sh | sudo sh -s -- --version=2.1.0-beta.1
  ```

  需要强制让预发布占用 `latest` 时用 `--latest`（一般只在灰度环境这么做）。
- `--require-clean` 会在 `probes/agent` 有未提交改动时直接失败，正式发布建议带上。

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
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--out <dir>` | `probes/agent/dist` | 输出目录（每次构建会先清空，已加进 `.gitignore`） |
| `--base-url <url>` | `https://get.beaconix.app/probe` | 写进 `latest.json` 的 tarball 地址前缀 |
| `--install-url <url>` | `https://get.beaconix.app/install.sh` | 写进 `latest.json` 的安装脚本地址 |
| `--no-scf` | 构建 | 跳过腾讯云 SCF zip |
| `--latest` / `--no-latest` | 稳定版生成 | 强制开 / 关 `latest` 别名与 `latest.json` |
| `--require-clean` | 关 | `probes/agent` 有未提交改动时报错 |
| `--no-verify` | 关 | 跳过构建后的归档校验（不建议） |

输出示例：

```
Beacon probe agent 2.0.0 (latest, fde31d2)
Output: probes/agent/dist

  beaconix-probe-2.0.0.tar.gz          21.6 KiB
  beaconix-probe-latest.tar.gz         21.6 KiB
  beaconix-probe-scf-2.0.0.zip         29.6 KiB
  install.sh                           5.8 KiB
  latest.json                          publish manifest
  SHA256SUMS                           checksums
```

### 构建后自动校验

默认（`--no-verify` 可关）脚本会：

1. 把 tar.gz 解压到临时目录，确认 `bin/beaconix-probe.js`、`package.json` 存在；
2. 对归档里每个 `.js` 执行 `node --check`（语法级回归）；
3. 直接运行解压出来的 CLI 的 `version`，比对是否等于 `package.json` 的版本；
4. 把生成的 SCF zip 解析回来，逐条校验 CRC 与解压后长度（保证上传到云厂商不会坏包）；
5. 检查 `install.sh` 仍在按 `beaconix-probe-$VERSION.tar.gz` 下载（防止契约漂移）。

> 校验第 1 步需要系统里有 `tar`。没有 `tar` 时只跳过这一步并打印 warning，其余检查照常。

---

## 4. 产物内部布局

### 4.1 探针 tar.gz

```
RELEASE.json                      # 版本 / commit / 源码时间 / engines
bin/beaconix-probe.js             # 0755，CLI 入口
src/...                           # 全部运行时代码
functions/scf.js                  # 云函数入口（随包附带，便于现场改部署形态）
install/install.sh                # 安装脚本本身
install/beacon-probe.service.tpl  # systemd unit 模板
package.json                      # 版本来源，必须存在
```

不包含 `test/`、`dist/`、`scripts/`、`node_modules/`——探针运行时零依赖，
安装目录只保留运行所需文件。

### 4.2 SCF zip

```
functions/scf.js
src/...
package.json
RELEASE.json
```

`functions/scf.js` 里用的是 `require('../src/...')`，所以 zip 必须保留
`functions/` 这层目录，**不能**把 `scf.js` 挪到根目录。控制台 handler 填
`functions/scf.main_handler`；环境变量见
[云函数部署指南](../docs/guides/probe-scf-deployment.md)（`/docs` 为本地文档，未纳入版本库）。

### 4.3 `latest.json`

```json
{
    "name": "@beaconix/probe-agent",
    "version": "2.0.0",
    "channel": "latest",
    "tarball": "https://get.beaconix.app/probe/beaconix-probe-2.0.0.tar.gz",
    "installUrl": "https://get.beaconix.app/install.sh",
    "sha256": "<tar.gz 的 sha256>",
    "engines": { "node": ">=18" },
    "commit": "fde31d2",
    "sourceDate": "2026-10-16T01:08:28+08:00",
    "latestTarball": "https://get.beaconix.app/probe/beaconix-probe-latest.tar.gz",
    "scf": {
        "tarball": "https://get.beaconix.app/probe/beaconix-probe-scf-2.0.0.zip",
        "handler": "functions/scf.main_handler"
    }
}
```

构建是可复现的：归档内所有时间戳取自 git 提交时间（`sourceDate`），不写构建
机器的当前时间；同样的提交 + 同样的版本号会得到同样的字节。

---

## 5. 发布到下载源

把 `probes/agent/dist/` 下的文件按下面的路径映射上传到对象存储 / CDN
（示例是 S3 兼容存储；用 R2 / OSS / COS 同理）：

| 本地产物 | 线上 URL | 缓存策略 |
| --- | --- | --- |
| `beaconix-probe-2.0.0.tar.gz` | `https://get.beaconix.app/probe/beaconix-probe-2.0.0.tar.gz` | 长缓存（`max-age=31536000, immutable`） |
| `beaconix-probe-latest.tar.gz` | `https://get.beaconix.app/probe/beaconix-probe-latest.tar.gz` | 短缓存（60s 或 no-cache） |
| `beaconix-probe-scf-2.0.0.zip` | `https://get.beaconix.app/probe/beaconix-probe-scf-2.0.0.zip` | 长缓存（同上） |
| `latest.json` | `https://get.beaconix.app/probe/latest.json` | **必须短缓存**（60s 或 no-cache），否则 `self-update` 长期看不到新版本 |
| `SHA256SUMS` | `https://get.beaconix.app/probe/SHA256SUMS` | 短缓存 |
| `install.sh` | `https://get.beaconix.app/install.sh` | 短缓存（它是入口脚本，改一次要尽快生效） |

```bash
# 示例：rclone
rclone copy probes/agent/dist/beaconix-probe-2.0.0.tar.gz   r2:beaconix/probe/
rclone copy probes/agent/dist/beaconix-probe-scf-2.0.0.zip  r2:beaconix/probe/
rclone copy probes/agent/dist/SHA256SUMS                    r2:beaconix/probe/
rclone copy probes/agent/dist/latest.json                   r2:beaconix/probe/
# latest 别名最后上传，避免指向还不存在的版本
rclone copy probes/agent/dist/beaconix-probe-latest.tar.gz  r2:beaconix/probe/
rclone copy probes/agent/dist/install.sh                    r2:beaconix/
```

**上传顺序**：具体版本文件 → `SHA256SUMS` → `latest.json` → `latest` 别名 →
`install.sh`。任何时刻中断，线上都只会指向已经存在的完整文件。

发布后校验：

```bash
curl -fsSL https://get.beaconix.app/probe/latest.json | head -20
curl -fsSL https://get.beaconix.app/probe/SHA256SUMS | sha256sum -c --ignore-missing
curl -fsSLI https://get.beaconix.app/probe/beaconix-probe-latest.tar.gz | head -1
```

---

## 6. 安装 / 升级链路

```
用户机器                                CDN                                    Beacon API
   │  curl install.sh                      │                                        │
   ├─────────────────────────────────────▶│                                        │
   │  GET /probe/beaconix-probe-latest.tar.gz                                       │
   ├─────────────────────────────────────▶│                                        │
   │  解压到 /opt/beaconix-probe           │                                        │
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
- `install.sh` 的下载源可用 `BEACON_DOWNLOAD_BASE` 覆盖，API 地址可用
  `BEACON_API_URL` 覆盖，私有化部署直接改这两个变量即可。
- systemd unit 由 `install.sh` 生成，`ExecStart=<node> /opt/beaconix-probe/bin/beaconix-probe.js run`，
  所以升级只要替换 `/opt/beaconix-probe` 内容并 `systemctl restart`，unit 无需改。

### 6.1 容器形态（`probes/Dockerfile`）

镜像本身**不含 agent 代码**：容器首次启动时由 `probes/docker-entrypoint.sh`
把已发布产物下载到 `/data/agent`，然后交给 `run`；`run` 发现没有凭据就自动发起
设备码授权，把验证链接和用户码打到 `docker logs`，批准后自动进入正常业务。
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
| `BEACON_API_URL` | — | 未登录时必填；生产必须 https |
| `PROBE_ENROLL_TOKEN` | 空 | 用 Web 下发的一次性 token 代替设备码登录 |
| `PROBE_VERSION` | `latest` | 指定要下载的发布版本 |
| `BEACON_DOWNLOAD_BASE` | `https://get.beaconix.app/probe` | 下载源（内网镜像 / 本机 dist） |
| `PROBE_FORCE_INSTALL` | `0` | 设为 1 时重启会重新下载（升级用，凭据保留） |

其他行为：

- **持久化**：`/data`（安装 `/data/agent`、凭据 `/data/etc/probe.json`）。不挂卷，
  容器重建后要重新登录。
- **不要 publish 端口**：探针纯出站。
- **没有 healthcheck**：没有本地端点，以后台「最后心跳」为准。
- **优雅退出**：entrypoint 用 `exec` 启动 `run`，`SIGTERM` 直达 node；compose
  给了 20s 宽限。
- **透传子命令**：`docker run --rm ... beacon-probe validate`（或 `run --once`、
  `status`）会跳过登录直接执行。
- **登录失败**（拒绝/超时）容器退出，`docker start` 重新出码即可。
- **升级**：改 `PROBE_VERSION` 并设 `PROBE_FORCE_INSTALL=1`，`docker compose up -d`；
  旧凭据继续有效。

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
          aws s3 cp probes/agent/dist/beaconix-probe-2.0.0.tar.gz s3://beaconix/probe/
          aws s3 cp probes/agent/dist/beaconix-probe-scf-2.0.0.zip s3://beaconix/probe/
          aws s3 cp probes/agent/dist/SHA256SUMS s3://beaconix/probe/
          aws s3 cp probes/agent/dist/latest.json s3://beaconix/probe/
          aws s3 cp probes/agent/dist/beaconix-probe-latest.tar.gz s3://beaconix/probe/
          aws s3 cp probes/agent/dist/install.sh s3://beaconix/
```

注意：CI 里版本号仍来自 `probes/agent/package.json`，tag 只用于触发；发布前确保
tag 版本与 `package.json` 一致（可在 step 里加一条断言）。

---

## 9. 待加固项（当前尚未实现）

- **`install.sh` 不校验完整性**：只下载 tar.gz 并解压。建议下一步在 installer 里拉
  `SHA256SUMS` 并 `sha256sum -c`，失败即退出。`latest.json.sha256` 已经预留了该值。
  （容器 entrypoint 目前也只做下载解压，建议一并补上 `sha256sum -c`。）
- **没有签名**：产物可被下载源篡改。若要防供应链攻击，可加 minisign/cosign 签名，
  并在 `install.sh` 里验签。
- **依赖宿主机 Node**：`install.sh` 要求目标机已装 Node ≥ 18。若想完全自包含，可另出
  一个 Node SEA / 单文件可执行产物的发布通道（当前 `--no-scf` 之类的开关不影响主链路）。
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
| 安装后 `beaconix-probe: command not found` | 软链 `/usr/local/bin/beaconix-probe` 没建（通常是脚本中途失败） | 重跑 `install.sh`；检查 `/usr/local/bin` 是否在 PATH |
| SCF 报 `Cannot find module '../src/config'` | zip 把 `scf.js` 放到了根目录 | 保持 `functions/scf.js` + `src/` 布局，handler 用 `functions/scf.main_handler` |
| SCF 探针频繁 OFFLINE | 触发器周期 ≠ `PROBE_INTERVAL_SECONDS` | 两者必须相等，按部署指南设置 |
| 容器日志出现 `curl: (22) … 404` / `curl: (6) Could not resolve host` | 下载源不可达，或该版本文件不存在 | 检查 `BEACON_DOWNLOAD_BASE` 与 `PROBE_VERSION`（预发布不写 `latest` 别名） |
| 容器重建后又要求登录 | `/data` 没挂持久卷 | `-v beacon-probe-data:/data`（compose 已配命名卷） |
| 升级后 `version` 没变 | 已安装的 payload 被直接复用 | 设 `PROBE_FORCE_INSTALL=1` 后重启，凭据保留 |
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
