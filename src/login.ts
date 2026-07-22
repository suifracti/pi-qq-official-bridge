/**
 * QQ Official Bot QR login (same flow as AstrBot):
 * 1) create_bind_task
 * 2) show QR (q.qq.com connect page)
 * 3) poll_bind_result + AES-GCM decrypt secret
 * 4) write config.json
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { createBindTask, waitForBind } from "./qq/qr-login.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = process.env.PI_QQ_CONFIG
  ? resolve(process.env.PI_QQ_CONFIG)
  : resolve(ROOT, "config.json");
const EXAMPLE_PATH = resolve(ROOT, "config.example.json");

async function main(): Promise<void> {
  console.log("=== Pi × QQ 官方机器人 · 扫码一键绑定 ===");
  console.log("流程与 AstrBot 相同：手机 QQ 扫码授权后自动写入 AppID/AppSecret\n");

  const task = await createBindTask();
  console.log(`task_id: ${task.taskId}`);
  console.log(`绑定页: ${task.qrUrl}\n`);

  // Print scannable QR in terminal
  const qr = await QRCode.toString(task.qrUrl, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "M",
  });
  console.log(qr);
  console.log("请用【手机 QQ】扫描上方二维码完成绑定。");
  console.log("（若终端二维码不好扫，浏览器打开绑定页也可以）\n");

  // Best-effort open browser on macOS / linux / windows
  void openUrl(task.qrUrl);

  const ac = new AbortController();
  const onSig = () => {
    console.log("\n已取消扫码。");
    ac.abort();
  };
  process.on("SIGINT", onSig);

  let dots = 0;
  try {
    const result = await waitForBind(task, {
      signal: ac.signal,
      onTick: (r) => {
        if (r.status === "pending") {
          dots = (dots + 1) % 4;
          const pad = ".".repeat(dots).padEnd(3, " ");
          process.stdout.write(`\r等待扫码确认中${pad} (status=${r.qrStatus})   `);
        }
      },
    });

    process.stdout.write("\n");
    console.log("✓ 扫码成功");
    console.log(`  AppID : ${result.appId}`);
    console.log(`  Secret: ${maskSecret(result.clientSecret)}`);

    const cfg = loadOrCreateConfig();
    cfg.appId = result.appId;
    cfg.clientSecret = result.clientSecret;
    ensureDirs(cfg);
    writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    console.log(`\n已写入配置: ${CONFIG_PATH}`);
    console.log("\n下一步启动桥接:");
    console.log("  npm start");
    console.log("\n安全建议: 启动后看日志里的 from=openid，填进 config.bridge.allowOpenIds");
  } finally {
    process.off("SIGINT", onSig);
  }
}

function loadOrCreateConfig(): Record<string, any> {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, any>;
  }
  if (existsSync(EXAMPLE_PATH)) {
    copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, any>;
  }
  return {
    appId: "",
    clientSecret: "",
    sandbox: false,
    intents: {
      publicMessages: true,
      publicGuildMessages: false,
      directMessage: false,
    },
    backend: "pideck",
    pideck: {
      baseUrl: "http://127.0.0.1:8765",
      projectId: "builtin-chat",
      bindingsPath: resolve(ROOT, "sessions/pideck-bindings.json"),
      pollIntervalMs: 800,
      timeoutMs: 600000,
      titlePrefix: "QQ",
    },
    pi: {
      cwd: process.cwd(),
      agentDir: `${process.env.HOME || process.env.USERPROFILE || ""}/.pi/agent`,
      sessionDir: resolve(ROOT, "sessions"),
    },
    bridge: {
      allowOpenIds: [],
      allowGroupOpenIds: [],
      wakePrefix: "",
      ignoreBotMessages: true,
      maxReplyChars: 1800,
      busyText: "上一条还在处理，请稍后再发。",
      errorText: "处理失败，请稍后再试。",
      thinkingText: "收到，已同步到 PiDeck，处理中…",
      sendThinkingAck: true,
      commands: {
        newSession: ["/new", "/reset", "新会话"],
        help: ["/help", "帮助"],
      },
    },
  };
}

function ensureDirs(cfg: Record<string, any>): void {
  const cwd = cfg?.pi?.cwd;
  const sessionDir = cfg?.pi?.sessionDir;
  if (typeof cwd === "string" && cwd) mkdirSync(cwd, { recursive: true });
  if (typeof sessionDir === "string" && sessionDir) mkdirSync(sessionDir, { recursive: true });
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function openUrl(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else if (platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error("\n扫码绑定失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
