import {
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { PATHS, hasConfig } from "./paths.js";

export type DaemonState = {
  pid: number;
  startedAt: string;
  packageRoot: string;
  logFile: string;
};

export type DaemonStatus =
  | { running: true; state: DaemonState; pidAlive: true }
  | { running: false; reason: "no-pid" | "dead"; state?: DaemonState };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readDaemonState(): DaemonState | undefined {
  try {
    if (!existsSync(PATHS.pidFile)) return undefined;
    const raw = JSON.parse(readFileSync(PATHS.pidFile, "utf8")) as DaemonState;
    if (!raw?.pid || typeof raw.pid !== "number") return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export function getDaemonStatus(): DaemonStatus {
  const state = readDaemonState();
  if (!state) return { running: false, reason: "no-pid" };
  if (!isAlive(state.pid)) return { running: false, reason: "dead", state };
  return { running: true, state, pidAlive: true };
}

export async function checkPiDeck(baseUrl = "http://127.0.0.1:8765"): Promise<{
  ok: boolean;
  detail: string;
}> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${text}` };
    return { ok: true, detail: text };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveTsx(root: string): { cmd: string; argsPrefix: string[] } {
  const binDir = join(root, "node_modules", ".bin");
  const candidates =
    process.platform === "win32"
      ? [join(binDir, "tsx.cmd"), join(binDir, "tsx.ps1"), join(binDir, "tsx")]
      : [join(binDir, "tsx")];
  for (const localTsx of candidates) {
    if (existsSync(localTsx)) return { cmd: localTsx, argsPrefix: [] };
  }
  return { cmd: process.platform === "win32" ? "npx.cmd" : "npx", argsPrefix: ["tsx"] };
}

/**
 * Start QQ bridge as a detached daemon (independent of PiDeck dialog lifetime).
 * Only one instance via pid file.
 */
export async function startDaemon(options?: {
  force?: boolean;
  pideckBaseUrl?: string;
}): Promise<{ ok: true; state: DaemonState; already?: boolean } | { ok: false; error: string }> {
  if (!hasConfig()) {
    return {
      ok: false,
      error: `未找到 config.json。请先在终端执行：\ncd ${PATHS.root}\nnpm run login`,
    };
  }

  const existing = getDaemonStatus();
  if (existing.running) {
    if (!options?.force) {
      return { ok: true, state: existing.state, already: true };
    }
    await stopDaemon();
  } else if (existing.state) {
    // stale pid
    try {
      unlinkSync(PATHS.pidFile);
    } catch {
      // ignore
    }
  }

  const baseUrl = options?.pideckBaseUrl || readPideckBaseUrl();
  const health = await checkPiDeck(baseUrl);
  if (!health.ok) {
    return {
      ok: false,
      error: [
        `PiDeck Web 服务不可用 (${baseUrl})`,
        health.detail,
        "",
        "请：",
        "1) 打开 PiDeck",
        "2) 设置 → 开启 Web 服务（8765）",
        "3) 或: cd " + PATHS.root + " && npm run enable-webservice 后重启 PiDeck",
        "4) curl " + baseUrl + "/api/health",
      ].join("\n"),
    };
  }

  mkdirSync(PATHS.root, { recursive: true });
  const logFd = openSync(PATHS.logFile, "a");
  const { cmd, argsPrefix } = resolveTsx(PATHS.root);
  const args = [...argsPrefix, "src/index.ts"];

  let child: ChildProcess;
  try {
    child = spawn(cmd, args, {
      cwd: PATHS.root,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        PI_QQ_DAEMON: "1",
        PI_QQ_CONFIG: PATHS.config,
        PIDEEK_BASE_URL: baseUrl,
        PI_QQ_BACKEND: "pideck",
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: `启动失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!child.pid) {
    return { ok: false, error: "spawn 未返回 pid" };
  }

  child.unref();

  const state: DaemonState = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    packageRoot: PATHS.root,
    logFile: PATHS.logFile,
  };
  writeFileSync(PATHS.pidFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  // brief wait + verify still alive
  await sleep(800);
  if (!isAlive(child.pid)) {
    const tail = tailLog(40);
    return {
      ok: false,
      error: `进程启动后立即退出。日志:\n${tail || "(空)"}`,
    };
  }

  return { ok: true, state };
}

export async function stopDaemon(): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const status = getDaemonStatus();
  if (!status.running) {
    try {
      if (existsSync(PATHS.pidFile)) unlinkSync(PATHS.pidFile);
    } catch {
      // ignore
    }
    return { ok: true, message: "QQ 桥接未在运行。" };
  }

  const pid = status.state.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    return {
      ok: false,
      error: `无法停止 pid=${pid}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  for (let i = 0; i < 20; i++) {
    if (!isAlive(pid)) break;
    await sleep(150);
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }

  try {
    unlinkSync(PATHS.pidFile);
  } catch {
    // ignore
  }

  return { ok: true, message: `已停止 QQ 桥接（pid=${pid}）。` };
}

export function formatStatus(): string {
  const lines: string[] = ["【QQ ↔ PiDeck 桥接】"];
  lines.push(`包目录: ${PATHS.root}`);
  lines.push(`配置: ${hasConfig() ? PATHS.config : "缺失（需 npm run login）"}`);

  const st = getDaemonStatus();
  if (st.running) {
    lines.push(`状态: 运行中`);
    lines.push(`PID: ${st.state.pid}`);
    lines.push(`启动: ${st.state.startedAt}`);
    lines.push(`日志: ${st.state.logFile}`);
  } else {
    lines.push(`状态: 未运行${st.reason === "dead" ? "（pid 文件残留已失效）" : ""}`);
    lines.push(`日志: ${PATHS.logFile}`);
  }

  return lines.join("\n");
}

export function tailLog(lines = 30): string {
  try {
    if (!existsSync(PATHS.logFile)) return "";
    const text = readFileSync(PATHS.logFile, "utf8");
    return text.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function readPideckBaseUrl(): string {
  try {
    if (!hasConfig()) return "http://127.0.0.1:8765";
    const cfg = JSON.parse(readFileSync(PATHS.config, "utf8")) as {
      pideck?: { baseUrl?: string };
    };
    return cfg.pideck?.baseUrl || process.env.PIDEEK_BASE_URL || "http://127.0.0.1:8765";
  } catch {
    return "http://127.0.0.1:8765";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
