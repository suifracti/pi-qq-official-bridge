import { createDecipheriv, randomBytes } from "node:crypto";

const DEFAULT_HOST = "q.qq.com";
const BIND_STATUS = {
  NONE: 0,
  PENDING: 1,
  COMPLETED: 2,
  EXPIRED: 3,
} as const;

export interface QrBindTask {
  taskId: string;
  bindKey: string;
  /** URL encoded into the QR code (same as AstrBot) */
  qrUrl: string;
  pollIntervalSec: number;
}

export type QrPollResult =
  | { status: "pending"; qrStatus: number }
  | { status: "expired"; qrStatus: number; message: string }
  | { status: "error"; qrStatus?: number; message: string }
  | {
      status: "created";
      qrStatus: number;
      appId: string;
      clientSecret: string;
    };

export function generateBindKey(): string {
  return randomBytes(32).toString("base64");
}

export function buildConnectUrl(taskId: string, host = DEFAULT_HOST): string {
  const h = normalizeHost(host);
  return `https://${h}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`;
}

export async function createBindTask(options?: {
  host?: string;
  timeoutMs?: number;
  pollIntervalSec?: number;
}): Promise<QrBindTask> {
  const host = normalizeHost(options?.host || DEFAULT_HOST);
  const bindKey = generateBindKey();
  const data = await postJson(`https://${host}/lite/create_bind_task`, { key: bindKey }, options?.timeoutMs);
  const payload = asObject(data.data);
  const taskId = String(payload.task_id || "").trim();
  if (!taskId) throw new Error("QQ 绑定任务响应缺少 task_id");

  return {
    taskId,
    bindKey,
    qrUrl: buildConnectUrl(taskId, host),
    pollIntervalSec: Math.max(1, options?.pollIntervalSec ?? 2),
  };
}

export async function pollBindOnce(options: {
  taskId: string;
  bindKey: string;
  host?: string;
  timeoutMs?: number;
}): Promise<QrPollResult> {
  const host = normalizeHost(options.host || DEFAULT_HOST);
  const data = await postJson(
    `https://${host}/lite/poll_bind_result`,
    { task_id: options.taskId },
    options.timeoutMs,
  );
  return mapPollResult(data, options.bindKey);
}

export async function waitForBind(
  task: QrBindTask,
  options?: {
    host?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onTick?: (result: QrPollResult) => void;
  },
): Promise<Extract<QrPollResult, { status: "created" }>> {
  const intervalMs = Math.max(1, task.pollIntervalSec) * 1000;
  while (true) {
    if (options?.signal?.aborted) throw new Error("扫码已取消");
    const result = await pollBindOnce({
      taskId: task.taskId,
      bindKey: task.bindKey,
      host: options?.host,
      timeoutMs: options?.timeoutMs,
    });
    options?.onTick?.(result);
    if (result.status === "created") return result;
    if (result.status === "expired" || result.status === "error") {
      throw new Error(result.message || "扫码失败");
    }
    await sleep(intervalMs, options?.signal);
  }
}

export function decryptBotSecret(encryptedSecret: string, bindKey: string): string {
  let key: Buffer;
  let raw: Buffer;
  try {
    key = Buffer.from(bindKey, "base64");
    raw = Buffer.from(encryptedSecret, "base64");
  } catch (err) {
    throw new Error("QQ 机器人凭证解码失败", { cause: err });
  }
  if (key.length !== 32 || raw.length <= 28) {
    throw new Error("QQ 机器人凭证密文格式异常");
  }

  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch (err) {
    throw new Error("QQ 机器人凭证解密失败", { cause: err });
  }
}

function mapPollResult(data: Record<string, unknown>, bindKey: string): QrPollResult {
  const payload = asObject(data.data);
  let rawStatus = Number(payload.status ?? BIND_STATUS.NONE);
  if (!Number.isFinite(rawStatus)) rawStatus = BIND_STATUS.NONE;

  if (rawStatus === BIND_STATUS.COMPLETED) {
    const appId = String(payload.bot_appid || "").trim();
    const encrypted = String(payload.bot_encrypt_secret || "").trim();
    if (!appId || !encrypted) {
      return {
        status: "error",
        qrStatus: rawStatus,
        message: "扫码成功但未返回完整 QQ 机器人凭证",
      };
    }
    try {
      const clientSecret = decryptBotSecret(encrypted, bindKey);
      return {
        status: "created",
        qrStatus: rawStatus,
        appId,
        clientSecret,
      };
    } catch (err) {
      return {
        status: "error",
        qrStatus: rawStatus,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (rawStatus === BIND_STATUS.EXPIRED) {
    return { status: "expired", qrStatus: rawStatus, message: "二维码已过期，请重新扫码" };
  }

  return { status: "pending", qrStatus: rawStatus };
}

async function postJson(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
    if (!data || typeof data !== "object") {
      throw new Error("QQ 机器人绑定接口响应格式异常");
    }
    const retcode = data.retcode;
    if (retcode != null) {
      const ok = Number(retcode) === 0;
      if (!ok) {
        const message =
          String(data.msg || data.message || "").trim() || "QQ 机器人绑定接口返回失败";
        throw new Error(message);
      }
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeHost(host: string): string {
  return host
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .trim() || DEFAULT_HOST;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("扫码已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("扫码已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
