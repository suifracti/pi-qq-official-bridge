# pi-qq-official-bridge

**QQ 官方机器人 ↔ PiDeck** 桥接扩展。

在 QQ 里 @ 机器人说话，消息进入本机 [PiDeck](https://github.com/ayuayue/PiDeck) 对话框，调用与桌面相同的 Pi Agent（读文件、跑命令、写代码），再把回答同步回 QQ。

> 与 PiDeck 内置「飞书 Bridge」同类能力。  
> PiDeck / pi 官方仓库**没有**第三方 IM 桥挂载点，本项目作为独立 **pi package** 发布，通过 PiDeck Web Service（`127.0.0.1:8765`）对接。

## 功能

- QQ 群 @ / 私聊 → PiDeck 对话框（可选手动选择会话）
- 正文流式推送到 QQ（思考 / bash 可选）
- 任务运行中再发消息 = 引导（steer）
- `/stop` 停止当前生成
- 图片 / 文件收发（`[SEND_FILE:路径]`）
- 纯 @ 无正文也可唤醒
- macOS / Windows / Linux（Node ≥ 20）

## 架构

```
QQ 用户
  │ WebSocket（QQ 官方机器人）
  ▼
pi-qq-official-bridge（守护进程）
  │ HTTP  http://127.0.0.1:8765
  ▼
PiDeck Web Service → Agent 对话框 → pi --mode rpc
  │
  ▼
回答回 QQ
```

## 要求

1. [PiDeck](https://github.com/ayuayue/PiDeck/releases) 已安装并运行  
2. 开启 **Web 服务**（默认 `127.0.0.1:8765`）  
3. Node.js **≥ 20**  
4. QQ 官方机器人（可用本仓库扫码绑定）

## 安装

### 方式 A：Pi 扩展（推荐）

```bash
git clone https://github.com/suifracti/pi-qq-official-bridge.git
cd pi-qq-official-bridge
npm install
npm run login                 # 手机 QQ 扫码写入 config.json
npm run enable-webservice     # 打开 PiDeck Web 服务后，请完全重启 PiDeck
pi install .
```

在任意 **PiDeck 对话框** 中：

```text
/qq start
```

### 方式 B：独立进程

```bash
npm start
# 或
npm run dev
```

## PiDeck 内指令（扩展）

| 命令 | 说明 |
| --- | --- |
| `/qq start` | 启动桥接守护进程 |
| `/qq stop` | 停止 |
| `/qq status` | 状态 |
| `/qq log` | 最近日志 |
| `/qq setup` | 环境检查 |
| `/qq autostart on\|off` | 会话加载时自动 start |

日志：`~/.pi/agent/qq/daemon.log`（Windows：`%USERPROFILE%\.pi\agent\qq\daemon.log`）

## QQ 内指令

| 命令 | 说明 |
| --- | --- |
| `/帮助` | 帮助 |
| `/对话框` | 列出并选择 PiDeck 对话框 |
| `/对话框 1` | 选第 1 个 |
| `/新会话` | 新建对话框并绑定 |
| `/停止` `/stop` | 停止当前生成 |
| `/输出` | 流式开关状态 |
| `/输出 思考 开\|关` | 是否推送思考 |
| `/输出 bash 开\|关` | 是否推送工具输出 |
| `/模型` `/思考` `/计划模式` | 同 PiDeck 控制 |

未绑定对话框时发消息，会先让你选择，不会自动乱跑。

## 配置

`config.json`（`npm run login` 生成，**勿提交**）：

见 [`config.example.json`](./config.example.json)。路径支持相对包根目录；`~/.pi/agent` 会展开用户目录。

常用环境变量：

- `QQ_APP_ID` / `QQ_CLIENT_SECRET`
- `PIDEEK_BASE_URL`（默认 `http://127.0.0.1:8765`）
- `PIDEEK_PROJECT_ID`（默认 `builtin-chat`）
- `PI_QQ_CONFIG`（config 路径）
- `PIDEEK_SETTINGS`（enable-webservice 用）

## Windows 说明

| 项目 | 状态 |
| --- | --- |
| Node 桥接进程 / `tsx` | 支持（自动找 `tsx.cmd`） |
| PiDeck Web Service | 支持（settings 在 `%APPDATA%\pi-desktop\`） |
| `npm run login` 扫码 | 支持（会尝试打开浏览器） |
| 路径 | 已去 macOS 硬编码；用相对路径 + `USERPROFILE` |
| 进程守护 `/qq start` | 支持；若杀毒拦截请放行 Node |

PiDeck 本体提供 Windows 安装包；本桥接与系统无关，只要本机 8765 可达即可。

## 与 PiDeck 官方的关系

- 官方：https://github.com/ayuayue/PiDeck  
- 官方内置 **飞书** 桥，**无** QQ 官方机器人一等扩展市场/依附接口  
- 本仓库独立维护，通过公开 Web API 对接，不修改 PiDeck 源码（可选增强除外）

## 使用提醒

Pi/PiDeck 可执行本机命令；部署到群聊前，请在 `bridge.allowOpenIds` 中限制可使用机器人的账号。

## License

MIT
