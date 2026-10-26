# Moulin-EPDServer

面向电子墨水屏的自托管信息渲染与拉取服务。用 HTML / CSS / SVG 编写组件，由 Playwright / Chromium 在服务端渲染为墨水屏可用帧；设备通过 HTTP 轮询拉取全帧或局部更新。

适合挂在 NAS / 家用服务器上，驱动 ESP32 等墨水屏终端，或用内置模拟器先调试布局。

## 功能特性

- **可视化编排**：拖拽布局组件，支持多屏独立管理与 API Key
- **服务端渲染**：HTML / CSS / SVG 组件 → Playwright 出图 → 墨水屏编码
- **色彩模式**：黑白（`epd-bw-msb-v1`）与黑白红黄（`edp-bwry-v1`），含双面板布局
- **增量刷新**：不可变快照 + 黑白局部更新，减少全屏刷写
- **内置组件**：时钟、天气（Open-Meteo / 和风天气）、文本、矩形、Cursor / Claude Code 用量、Bambu / Klipper 打印状态等
- **无硬件调试**：浏览器内设备模拟器，无需真机即可预览
- **密钥管理**：第三方 Token 经 `EPD_MASTER_KEY` 加密入库，组件侧只引用 Secret ID

### 路线图 / TODO

- [x] 多屏管理、布局编辑与设备 API Key
- [x] Playwright 服务端渲染与 BW / BWRY 帧编码
- [x] 黑白局部更新（`partial` + region 双平面）
- [x] 屏幕布局导出 / 导入覆盖
- [x] 浏览器内设备模拟器
- [x] 密钥管理与组件 Secret 引用
- [x] Docker Compose / NAS 单实例部署
- [x] 官方内置组件（见下方）
- [ ] 拓展更多的组件
- [ ] 管理端导入 / 安装第三方 widget 包
- [ ] Widget 多色组件（面向 BWRY 的红 / 黄强调色样式与配置）
- [ ] 组件打包分发与版本升级流程


## 官方组件

组件源码位于 `packages/widgets/`。带独立说明的组件请直接阅读其 README。

| 组件 | 说明 | 使用说明 |
| --- | --- | --- |
| [`clock`](packages/widgets/clock/) | 时间与日期 | 选择样式（`default` / `minimal` / `dotdate`），配置时间格式、IANA 时区与是否显示日期；取渲染端系统当前时刻后再按时区格式化 |
| [`weather`](packages/widgets/weather/) | 实时天气（Open-Meteo） | 填写经纬度与地点名，可选摄氏/华氏、边框与缓存分钟数；天气与空气质量分属不同域名，空气质量失败时仍显示天气 |
| [`weather-qweather`](packages/widgets/weather-qweather/) | 实时天气（和风天气 JWT） | 见 [使用说明](packages/widgets/weather-qweather/README.md) |
| [`text`](packages/widgets/text/) | 自定义文本 | 填写文本、字号与对齐；样式含 `default` / `boxed` |
| [`rectangle`](packages/widgets/rectangle/) | 矩形 / 线段装饰 | 配置填充、描边与圆角；宽或高为 1px 时退化为线段 |
| [`cursor_usage`](packages/widgets/cursor_usage/) | Cursor 用量 | 见 [使用说明](packages/widgets/cursor_usage/README.md) |
| [`claude_usage`](packages/widgets/claude_usage/) | Claude Code 用量 | 见 [使用说明](packages/widgets/claude_usage/README.md) |
| [`bambu_print`](packages/widgets/bambu_print/) | 拓竹打印进度 | 见 [使用说明](packages/widgets/bambu_print/README.md) |
| [`klipper_print`](packages/widgets/klipper_print/) | Klipper / Snapmaker 打印进度 | 见下方简要说明 |

`exmaple` 为开发示例组件（默认禁用），规范见 [packages/widgets/exmaple/README.md](packages/widgets/exmaple/README.md)。

### 天气-和风天气

通过和风天气 JWT（Ed25519）拉取实况、小时预报与空气质量。在「密钥管理」选择用途「和风天气」生成密钥对，将公钥上传到和风控制台后，把 API Host、项目 ID、凭据 ID（kid）与私钥 Secret 填入组件。完整步骤见 [packages/widgets/weather-qweather/README.md](packages/widgets/weather-qweather/README.md)。

### Klipper 打印进度

通过局域网 HTTP 连接 Moonraker，只读取打印状态（通用 Klipper 或 Snapmaker U1）。

1. 确保 EPDServer 与打印机在同一可达局域网，建议给打印机固定 IP。
2. 若 Moonraker 启用了 API Key，在「密钥管理」用 `General Key` 保存，再把返回的 Secret ID / 名称填入组件的 `api_secret_id`。
3. 组件中填写打印机私网 IP；`compatibility` 选 `general` 或 `snapmaker_u1`（`port` 为 `0` 时使用该模式默认端口）。
4. 可选配置标题、是否显示任务名、缓存间隔。

## 架构概览

```text
浏览器管理端 (React / Vite)
        │
        ▼
 Fastify API  +  SQLite  +  快照存储
        │
        ├─ Playwright / Chromium 渲染组件
        └─ 编码为墨水屏帧 / 局部 region
                │
                ▼
        ESP32 / 模拟器 轮询拉取
```

| 目录 | 说明 |
| --- | --- |
| `frontend/` | 管理端 Web UI |
| `server/` | Fastify API、渲染管线、调度与设备接口 |
| `packages/widgets/` | 可安装的组件包（manifest + template + style） |
| `packages/widget-runtime/` | 组件运行时共享逻辑 |
| `docs/` | 协议与扩展文档 |

## 环境要求

- Node.js **22+**
- 本地开发需安装 Playwright Chromium
- 生产推荐 Docker（含 Chromium 运行时）
- **单实例**部署：SQLite 与调度器不支持多副本并发

## 快速开始

### 本地开发

后端：

```powershell
cd server
npm install
npx playwright install chromium
$env:EPD_DEBUG="true"
$env:EPD_MASTER_KEY="development-only-change-this-master-key"
$env:EPD_ADMIN_PASSWORD="change-me-now"
npm run dev
```

前端：

```powershell
cd frontend
npm install
npm run dev
```

打开 `http://localhost:5173`，默认用户名 `admin`，后端默认 `http://localhost:8000`。

### Linux 一键后台运行（原生，不依赖 Docker）

依赖：Node.js **22+**、npm、curl；编译 `better-sqlite3` 还需 **python3 / make / g++**。在仓库根目录执行：

```bash
chmod +x scripts/epdctl.sh
./scripts/epdctl.sh start
```

脚本会自动：缺失 Node 时安装 [nvm](https://github.com/nvm-sh/nvm)（`v0.40.6`）与 Node 22；缺失编译工具时尝试用 apt/dnf/yum/apk 安装；默认走 npmmirror 国内源（`EPD_NPM_MIRROR=0` 可关闭）；生成 `.env`（若不存在）、安装依赖、安装 Playwright Chromium、构建前后端，并以 `nohup` 后台启动。服务端同时托管管理端静态资源，默认端口 `5088`。

常用命令：

```bash
./scripts/epdctl.sh status   # 查看状态
./scripts/epdctl.sh logs -f  # 跟踪日志
./scripts/epdctl.sh stop     # 停止
./scripts/epdctl.sh update   # 依赖/代码更新后重装并启动
```

数据目录 `./data`，日志 `./logs/epdserver.log`。首次若 `playwright install --with-deps` 因权限失败，脚本会回退为仅安装浏览器；若启动后渲染报错，请手动执行：

```bash
cd server && npx playwright install --with-deps chromium
```

### Docker Compose / NAS（推荐生产部署）

隔离依赖与 Chromium 运行时，更适合长期挂机：

```bash
cp .env.example .env
# 编辑 .env：设置足够长的 EPD_MASTER_KEY 与强密码 EPD_ADMIN_PASSWORD
docker compose up -d --build
```

构建默认使用国内镜像。可在 `.env` 中分别关闭后重新 `--build`：`EPD_APT_MIRROR=0`（阿里云 apt/apk）、`EPD_NPM_MIRROR=0`（npmmirror / Playwright）。

默认访问 `http://<NAS-IP>:5088`。数据与快照保存在 `epd_data` 卷。若入口已配置 HTTPS，请在 `.env` 中设置 `EPD_COOKIE_SECURE=true`。

## 配置说明

复制 `.env.example` 为 `.env`。常用变量：

| 变量 | 说明 | 默认 / 备注 |
| --- | --- | --- |
| `EPD_MASTER_KEY` | 加密密钥材料 | **至少 32 字符**，生产必须更换 |
| `EPD_ADMIN_USERNAME` | 管理端用户名 | `admin` |
| `EPD_ADMIN_PASSWORD` | 管理端密码 | 生产必须更换 |
| `EPD_ALLOWED_ORIGINS` | CORS 允许来源 | 开发多为 `http://localhost:5173` |
| `EPD_COOKIE_SECURE` | Cookie 仅 HTTPS | 生产 HTTPS 时设为 `true` |
| `EPD_WEB_PORT` | 对外端口（原生脚本 / Compose） | `5088` |
| `EPD_APT_MIRROR` | Docker 构建是否用阿里云 apt/apk | 默认启用；`0` 关闭 |
| `EPD_NPM_MIRROR` | 原生安装 / Docker 构建是否用 npmmirror | 默认启用；`0` 关闭 |
| `EPD_VERSION` / `EPD_GIT_SHA` / `EPD_BUILD_TIME` | 编译版本（系统信息页展示） | 可选；原生构建自动生成 |
| `EPD_FRONTEND_DIR` | 管理端静态资源目录 | 原生脚本自动设为 `frontend/dist` |
| `EPD_SNAPSHOT_KEEP` | 每屏保留快照数 | `3`（最小 2） |
| `EPD_DEBUG` | 调试模式 | 生产保持 `false` |

更多服务端变量（数据库路径、数据目录、会话时长等）见 `server/src/config.ts`。

## 设备拉取（ESP32）

完整约定见 [docs/esp32-api.md](docs/esp32-api.md)。简要流程：

1. 管理端为屏幕生成仅显示一次的 API Key
2. 携带 `X-API-Key` 请求  
   `GET /api/v1/device/screens/{screen_id}/manifest`
3. 首次按 `frame_url` 拉全帧；后续传 `base_snapshot_id`
4. `304` 表示无变化；`partial` 时按序应用 `regions`（每区为 `[old][new]` 双平面）；基线不匹配时自动回退全帧
5. 校验 `X-Content-SHA256`，仅在完整接收并成功刷新后更新本地 snapshot ID

**帧格式**

- `epd-bw-msb-v1`：逐行 MSB-first 1bpp，`1` = 黑色
- `edp-bwry-v1`：每像素 2bit — 白 `00` / 黄 `01` / 红 `10` / 黑 `11`  
  `panel_layout=dual-panel-left-right` 时，偶数宽画面按「左半面板数据 + 右半面板数据」拼接

## 安全建议

- 生产环境务必更换 `EPD_MASTER_KEY` 与管理员密码
- 公网访问请使用 HTTPS，并限制管理端暴露面
- 设备 API Key 视为密钥，勿提交到仓库或日志
- 不要将含 Cursor Session Token 的实例暴露在无认证的公网
- 保持 API **单实例**运行，避免 SQLite / 调度器重复执行

## 组件开发

组件位于 `packages/widgets/<name>/`，通常包含：

- `manifest.json` — 类型、多语言标题、默认样式与 mock
- `schema.json` — 配置 Schema
- `data.ts` — 数据获取（可选）
- `styles/<style_id>/` — `template.html`、`style.css`、`style.manifest.json`

本地开发时后端会监听 `packages/widgets/**/*` 变更。目录与 Mock 规范见 [packages/widgets/exmaple/README.md](packages/widgets/exmaple/README.md)，也可参考 `clock`、`weather` 等现有组件。

## 贡献

欢迎 Issue 与 Pull Request。提交前请尽量：

1. 保持改动聚焦，避免无关格式化
2. 在本地验证相关路径（管理端 / 渲染 / 设备拉取）
3. 勿提交 `.env`、数据库、快照或含密钥的运行时数据

## 许可证

本项目采用 [MIT License](LICENSE)。