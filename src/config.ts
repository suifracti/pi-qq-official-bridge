import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export type BackendMode = "pideck" | "sdk";

export interface BridgeConfig {
  appId: string;
  clientSecret: string;
  sandbox: boolean;
  /** pideck = 同步到 PiDeck 对话框（推荐）；sdk = 独立 Pi 进程 */
  backend: BackendMode;
  intents: {
    publicMessages: boolean;
    publicGuildMessages: boolean;
    directMessage: boolean;
  };
  pideck: {
    baseUrl: string;
    projectId: string;
    bindingsPath: string;
    pollIntervalMs: number;
    timeoutMs: number;
    titlePrefix: string;
    /** 空闲超过该毫秒新开对话框，0=关闭，默认 12h */
    idleNewSessionMs: number;
    /** 上下文占用%超过则新开，0=关闭，默认 92 */
    contextFullPercent: number;
  };
  pi: {
    cwd: string;
    agentDir: string;
    sessionDir: string;
  };
  bridge: {
    allowOpenIds: string[];
    allowGroupOpenIds: string[];
    wakePrefix: string;
    ignoreBotMessages: boolean;
    maxReplyChars: number;
    busyText: string;
    errorText: string;
    thinkingText: string;
    sendThinkingAck: boolean;
    /** QQ 流式：正文 */
    streamText: boolean;
    /** QQ 流式：思考 */
    streamThinking: boolean;
    /** QQ 流式：bash/工具 */
    streamTools: boolean;
    commands: {
      newSession: string[];
      help: string[];
    };
  };
}

const ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS: BridgeConfig = {
  appId: "",
  clientSecret: "",
  sandbox: false,
  backend: "pideck",
  intents: {
    publicMessages: true,
    publicGuildMessages: false,
    directMessage: false,
  },
  pideck: {
    baseUrl: "http://127.0.0.1:8765",
    projectId: "builtin-chat",
    bindingsPath: resolve(ROOT_DEFAULT, "sessions/pideck-bindings.json"),
    pollIntervalMs: 800,
    timeoutMs: 600_000,
    titlePrefix: "QQ",
    idleNewSessionMs: 12 * 60 * 60 * 1000,
    contextFullPercent: 92,
  },
  pi: {
    cwd: process.cwd(),
    agentDir: resolve(homedir(), ".pi/agent"),
    sessionDir: resolve(ROOT_DEFAULT, "sessions"),
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
    sendThinkingAck: false,
    streamText: true,
    streamThinking: false,
    streamTools: false,
    commands: {
      newSession: ["/new", "/reset", "新会话"],
      help: ["/help", "帮助"],
    },
  },
};

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof base[k as keyof T] === "object" &&
      base[k as keyof T] !== null &&
      !Array.isArray(base[k as keyof T])
    ) {
      out[k] = deepMerge(
        base[k as keyof T] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadConfig(path = process.env.PI_QQ_CONFIG || resolve(process.cwd(), "config.json")): BridgeConfig {
  const configPath = resolve(path);
  if (!existsSync(configPath)) {
    throw new Error(
      `找不到配置文件: ${configPath}\n请先 npm run login，或复制 config.example.json 为 config.json`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<BridgeConfig>;
  const cfg = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    raw as Record<string, unknown>,
  ) as unknown as BridgeConfig;

  cfg.appId = process.env.QQ_APP_ID || cfg.appId;
  cfg.clientSecret = process.env.QQ_CLIENT_SECRET || cfg.clientSecret;
  if (process.env.PI_QQ_CWD) cfg.pi.cwd = process.env.PI_QQ_CWD;
  // resolve relative paths against package root
  const root = ROOT_DEFAULT;
  if (cfg.pideck.bindingsPath && !isAbs(cfg.pideck.bindingsPath)) {
    cfg.pideck.bindingsPath = resolve(root, cfg.pideck.bindingsPath);
  }
  if (cfg.pi.sessionDir && !isAbs(cfg.pi.sessionDir)) {
    cfg.pi.sessionDir = resolve(root, cfg.pi.sessionDir);
  }
  if (cfg.pi.agentDir && cfg.pi.agentDir.includes("~")) {
    cfg.pi.agentDir = cfg.pi.agentDir.replace(/^~(?=$|[\\/])/, homedir());
  }
  if (cfg.pi.agentDir && !isAbs(cfg.pi.agentDir)) {
    cfg.pi.agentDir = resolve(root, cfg.pi.agentDir);
  }
  if (process.env.PIDEEK_BASE_URL) cfg.pideck.baseUrl = process.env.PIDEEK_BASE_URL;
  if (process.env.PIDEEK_PROJECT_ID) cfg.pideck.projectId = process.env.PIDEEK_PROJECT_ID;
  if (process.env.PI_QQ_BACKEND === "pideck" || process.env.PI_QQ_BACKEND === "sdk") {
    cfg.backend = process.env.PI_QQ_BACKEND;
  }

  if (!cfg.appId || !cfg.clientSecret || cfg.appId.includes("你的")) {
    throw new Error("请先 npm run login 扫码绑定，或在 config.json 配置有效 appId/clientSecret");
  }
  if (cfg.backend !== "pideck" && cfg.backend !== "sdk") {
    cfg.backend = "pideck";
  }
  return cfg;
}

/** QQ bot intents bit flags (same as botpy) */
export function buildIntents(cfg: BridgeConfig["intents"]): number {
  let value = 0;
  if (cfg.directMessage) value |= 1 << 12;
  if (cfg.publicMessages) value |= 1 << 25;
  if (cfg.publicGuildMessages) value |= 1 << 30;
  return value;
}

function isAbs(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return true;
  // Windows drive
  return /^[a-zA-Z]:[\\/]/.test(p);
}
