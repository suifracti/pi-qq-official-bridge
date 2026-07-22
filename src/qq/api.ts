import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { QqAccessToken } from "./token.js";
import { qqFileTypeForPath } from "../util/attachments.js";

export type SendTarget =
  | { kind: "c2c"; openid: string }
  | { kind: "group"; groupOpenid: string }
  | { kind: "channel"; channelId: string };

export interface SendTextOptions {
  content: string;
  msgId?: string;
  msgSeq?: number;
  eventId?: string;
}

export interface QqMediaInfo {
  file_uuid?: string;
  file_info?: string;
  ttl?: number;
  [key: string]: unknown;
}

export class QqApi {
  private readonly baseUrl: string;

  constructor(
    private readonly token: QqAccessToken,
    sandbox = false,
  ) {
    this.baseUrl = sandbox
      ? "https://sandbox.api.sgroup.qq.com"
      : "https://api.sgroup.qq.com";
  }

  async getAuthorization(): Promise<string> {
    return this.token.getAuthorization();
  }

  async getGatewayUrl(): Promise<string> {
    const data = await this.request<{ url: string }>("GET", "/gateway/bot");
    if (!data?.url) throw new Error(`get gateway failed: ${JSON.stringify(data)}`);
    return data.url;
  }

  async sendText(target: SendTarget, options: SendTextOptions): Promise<unknown> {
    const payload: Record<string, unknown> = {
      content: options.content,
      msg_type: 0,
    };
    if (options.msgId) payload.msg_id = options.msgId;
    if (options.msgSeq != null) payload.msg_seq = options.msgSeq;
    if (options.eventId) payload.event_id = options.eventId;

    return this.sendMessage(target, payload);
  }

  async sendTextChunked(
    target: SendTarget,
    text: string,
    opts: { msgId?: string; eventId?: string; maxChars?: number; startSeq?: number } = {},
  ): Promise<number> {
    const max = opts.maxChars ?? 1800;
    const chunks = splitText(text, max);
    let seq = opts.startSeq ?? randomSeq();
    for (const chunk of chunks) {
      await this.sendText(target, {
        content: chunk,
        msgId: opts.msgId,
        eventId: opts.eventId,
        msgSeq: seq++,
      });
      if (chunks.length > 1) await sleep(250);
    }
    return seq;
  }

  /**
   * Upload local file/image then send as rich media (msg_type=7).
   * QQ file_type: 1 image, 2 video, 3 voice, 4 file
   */
  async sendLocalFile(
    target: SendTarget,
    filePath: string,
    opts: { msgId?: string; eventId?: string; msgSeq?: number; fileName?: string } = {},
  ): Promise<number> {
    if (target.kind === "channel") {
      throw new Error("频道暂不支持通过本桥发送本地文件，请用群/私聊");
    }
    if (!existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }

    const buf = readFileSync(filePath);
    if (!buf.length) throw new Error(`空文件: ${filePath}`);
    if (buf.length > 50 * 1024 * 1024) throw new Error(`文件过大(>50MB): ${filePath}`);

    const fileType = qqFileTypeForPath(filePath);
    const fileName = opts.fileName || basename(filePath);
    const media = await this.uploadMedia(target, {
      fileType,
      fileDataBase64: buf.toString("base64"),
      fileName,
    });

    const seq = opts.msgSeq ?? randomSeq();
    const payload: Record<string, unknown> = {
      msg_type: 7,
      media: {
        file_uuid: media.file_uuid,
        file_info: media.file_info,
      },
      msg_seq: seq,
    };
    if (opts.msgId) payload.msg_id = opts.msgId;
    if (opts.eventId) payload.event_id = opts.eventId;

    await this.sendMessage(target, payload);
    return seq + 1;
  }

  async uploadMedia(
    target: Exclude<SendTarget, { kind: "channel" }>,
    input: { fileType: number; fileDataBase64: string; fileName?: string; url?: string },
  ): Promise<QqMediaInfo> {
    const path =
      target.kind === "group"
        ? `/v2/groups/${encodeURIComponent(target.groupOpenid)}/files`
        : `/v2/users/${encodeURIComponent(target.openid)}/files`;

    const body: Record<string, unknown> = {
      file_type: input.fileType,
      srv_send_msg: false,
    };
    if (input.fileDataBase64) body.file_data = input.fileDataBase64;
    if (input.url) body.url = input.url;
    if (input.fileName) body.file_name = input.fileName;

    const data = await this.request<QqMediaInfo>("POST", path, body);
    if (!data?.file_info && !data?.file_uuid) {
      throw new Error(`上传媒体失败: ${JSON.stringify(data)}`);
    }
    return data;
  }

  private async sendMessage(target: SendTarget, payload: Record<string, unknown>): Promise<unknown> {
    if (target.kind === "c2c") {
      return this.request("POST", `/v2/users/${encodeURIComponent(target.openid)}/messages`, payload);
    }
    if (target.kind === "group") {
      return this.request(
        "POST",
        `/v2/groups/${encodeURIComponent(target.groupOpenid)}/messages`,
        payload,
      );
    }
    // channel API uses different shape; strip msg_type if present is ok for text
    return this.request(
      "POST",
      `/channels/${encodeURIComponent(target.channelId)}/messages`,
      payload,
    );
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const auth = await this.token.getAuthorization();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }
    if (!res.ok) {
      const err = new Error(
        `QQ API ${method} ${path} -> ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
      );
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return data as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomSeq(): number {
  return 1 + Math.floor(Math.random() * 900000);
}

function splitText(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return ["(空回复)"];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf("。", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
