/**
 * QQ Official Bot ↔ PiDeck bridge extension.
 *
 * Usage in PiDeck dialog (or pi CLI):
 *   /qq start | stop | status | restart | log | setup | help
 *
 * Architecture:
 *   QQ WebSocket  →  detached daemon (this package src/index.ts)
 *                 →  PiDeck Web Service :8765
 *                 →  Agent dialogs in PiDeck UI
 *
 * The bridge only works with PiDeck (backend=pideck). Keep PiDeck open.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PATHS, hasConfig, qqAgentDir } from "./paths.js";
import {
  checkPiDeck,
  formatStatus,
  getDaemonStatus,
  startDaemon,
  stopDaemon,
  tailLog,
} from "./daemon.js";

const AUTOSTART_FLAG = join(qqAgentDir(), "autostart");

function helpText(): string {
  return [
    "QQ ↔ PiDeck 桥接（仅 PiDeck）",
    "",
    "/qq start     启动桥接守护进程（需 PiDeck Web 服务）",
    "/qq stop      停止",
    "/qq restart   重启",
    "/qq status    状态",
    "/qq log       最近日志",
    "/qq setup     检查配置 / PiDeck / 依赖",
    "/qq login     提示如何扫码登录（需终端）",
    "/qq autostart on|off  本机是否在扩展加载时自动 start",
    "/qq help      帮助",
    "",
    "首次：终端执行",
    `  cd ${PATHS.root}`,
    "  npm install && npm run login",
    "  npm run enable-webservice  # 然后完全重启 PiDeck",
    "",
    "之后在任意 PiDeck 对话框：/qq start",
    "QQ 私聊机器人或群里 @机器人 即可，回答出现在 PiDeck 对话框并回传 QQ。",
  ].join("\n");
}

function isAutostart(): boolean {
  try {
    if (!existsSync(AUTOSTART_FLAG)) return false;
    return readFileSync(AUTOSTART_FLAG, "utf8").trim() !== "0";
  } catch {
    return false;
  }
}

function setAutostart(on: boolean) {
  writeFileSync(AUTOSTART_FLAG, on ? "1\n" : "0\n", "utf8");
}

async function setupReport(): Promise<string> {
  const lines: string[] = ["【QQ 桥接检查】"];
  lines.push(`包目录: ${PATHS.root}`);
  lines.push(`config.json: ${hasConfig() ? "✓" : "✗ 缺少，请 npm run login"}`);

  const nm = join(PATHS.root, "node_modules");
  lines.push(`node_modules: ${existsSync(nm) ? "✓" : "✗ 请 npm install"}`);

  const baseUrl = (() => {
    try {
      if (!hasConfig()) return "http://127.0.0.1:8765";
      const cfg = JSON.parse(readFileSync(PATHS.config, "utf8"));
      return cfg?.pideck?.baseUrl || "http://127.0.0.1:8765";
    } catch {
      return "http://127.0.0.1:8765";
    }
  })();

  const health = await checkPiDeck(baseUrl);
  lines.push(`PiDeck ${baseUrl}: ${health.ok ? "✓ " + health.detail : "✗ " + health.detail}`);

  const st = getDaemonStatus();
  lines.push(`守护进程: ${st.running ? `运行中 pid=${st.state.pid}` : "未运行"}`);
  lines.push(`autostart: ${isAutostart() ? "on" : "off"}`);

  if (!hasConfig()) {
    lines.push("", "下一步: 终端 cd 到包目录执行 npm run login");
  } else if (!health.ok) {
    lines.push("", "下一步: 打开 PiDeck 并开启 Web 服务后 /qq start");
  } else if (!st.running) {
    lines.push("", "下一步: /qq start");
  } else {
    lines.push("", "已就绪，可在 QQ 发消息。");
  }
  return lines.join("\n");
}

export default function qqExtension(pi: ExtensionAPI) {
  // Avoid nested agent child sessions starting another copy of UI hooks
  if (process.env.PI_QQ_CHILD === "1") return;

  pi.registerCommand("qq", {
    description: "QQ ↔ PiDeck 桥接：start/stop/status/setup",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      const [cmdRaw, ...rest] = raw.split(/\s+/);
      const cmd = (cmdRaw || "help").toLowerCase();
      const arg = rest.join(" ").trim();

      try {
        if (cmd === "help" || cmd === "h" || cmd === "?" || cmd === "帮助") {
          ctx.ui.notify(helpText(), "info");
          return;
        }

        if (cmd === "status" || cmd === "状态") {
          const health = await checkPiDeck();
          ctx.ui.notify(
            `${formatStatus()}\nPiDeck: ${health.ok ? "ok" : "down — " + health.detail}`,
            "info",
          );
          return;
        }

        if (cmd === "log" || cmd === "日志") {
          const log = tailLog(40) || "(日志为空)";
          ctx.ui.notify(log, "info");
          return;
        }

        if (cmd === "setup" || cmd === "检查") {
          ctx.ui.notify(await setupReport(), "info");
          return;
        }

        if (cmd === "login" || cmd === "扫码") {
          ctx.ui.notify(
            [
              "扫码登录需要终端交互，请在系统终端执行：",
              "",
              `cd ${PATHS.root}`,
              "npm run login",
              "",
              "完成后回 PiDeck 执行 /qq start",
            ].join("\n"),
            "info",
          );
          return;
        }

        if (cmd === "autostart") {
          const v = arg.toLowerCase();
          if (v === "on" || v === "1" || v === "开") {
            setAutostart(true);
            ctx.ui.notify("已开启 autostart：之后打开带本扩展的会话会尝试自动 /qq start", "info");
            return;
          }
          if (v === "off" || v === "0" || v === "关") {
            setAutostart(false);
            ctx.ui.notify("已关闭 autostart", "info");
            return;
          }
          ctx.ui.notify(`autostart 当前: ${isAutostart() ? "on" : "off"}\n用法: /qq autostart on|off`, "info");
          return;
        }

        if (cmd === "stop" || cmd === "停止") {
          const r = await stopDaemon();
          ctx.ui.notify(r.ok ? r.message : r.error, r.ok ? "info" : "error");
          return;
        }

        if (cmd === "start" || cmd === "启动") {
          ctx.ui.notify("正在启动 QQ 桥接…", "info");
          const r = await startDaemon({ force: arg === "force" || arg === "--force" });
          if (!r.ok) {
            ctx.ui.notify(r.error, "error");
            return;
          }
          ctx.ui.notify(
            r.already
              ? `QQ 桥接已在运行（pid=${r.state.pid}）\n日志: ${r.state.logFile}`
              : `QQ 桥接已启动（pid=${r.state.pid}）\n日志: ${r.state.logFile}\n请保持 PiDeck 开启，QQ 发消息即可。`,
            "info",
          );
          return;
        }

        if (cmd === "restart" || cmd === "重启") {
          await stopDaemon();
          const r = await startDaemon({ force: true });
          if (!r.ok) {
            ctx.ui.notify(r.error, "error");
            return;
          }
          ctx.ui.notify(`已重启 QQ 桥接（pid=${r.state.pid}）\n日志: ${r.state.logFile}`, "info");
          return;
        }

        ctx.ui.notify(`未知子命令: ${cmd}\n\n${helpText()}`, "error");
      } catch (err) {
        ctx.ui.notify(`QQ 命令失败: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // Optional autostart when a PiDeck/pi session loads this extension
  pi.on("session_start", async () => {
    if (!isAutostart()) return;
    if (getDaemonStatus().running) return;
    if (!hasConfig()) return;
    const health = await checkPiDeck();
    if (!health.ok) return;
    const r = await startDaemon();
    if (r.ok && !r.already) {
      // best-effort notify if UI available later
      console.log(`[qq-ext] autostart pid=${r.state.pid}`);
    }
  });
}
