import { sanitizeReplyForQq } from "./reply-text.js";

export type StreamKind = "text" | "thinking" | "tool";

export interface StreamPrefs {
  text: boolean;
  thinking: boolean;
  tools: boolean;
}

export const DEFAULT_STREAM_PREFS: StreamPrefs = {
  text: true,
  thinking: false,
  tools: false,
};

export interface OutChunk {
  kind: StreamKind;
  text: string;
}

export interface TrackedMsg {
  role: string;
  id: string;
  text?: string;
  thinking?: string;
}

/**
 * 按「整条助手气泡」推送，不再按句号切片（避免 Markdown/列表被拆烂）。
 * 气泡文本稳定 N 次轮询、或后面出现新消息、或 force 时发送整段。
 */
export class StreamTracker {
  /** key -> 已完整发送的文本 */
  private sentFull = new Map<string, string>();
  /** key -> 最近一次见到的文本 */
  private lastSeen = new Map<string, string>();
  /** key -> 文本连续不变的 poll 次数 */
  private stableCount = new Map<string, number>();
  private emittedParts: string[] = [];
  private readonly stableNeed: number;

  constructor(
    private prefs: StreamPrefs,
    stableNeed = 2,
  ) {
    this.stableNeed = stableNeed;
  }

  setPrefs(p: StreamPrefs) {
    this.prefs = p;
  }

  getEmittedTotal(): string {
    return this.emittedParts.join("\n\n");
  }

  /** 已发送过的纯文本集合（去空白） */
  getEmittedCompact(): string {
    return this.emittedParts.map((s) => s.replace(/\s+/g, "")).join("");
  }

  ingest(messages: TrackedMsg[], startIndex: number, force = false): OutChunk[] {
    const slice = messages.slice(startIndex);
    const out: OutChunk[] = [];

    for (let i = 0; i < slice.length; i++) {
      const m = slice[i];
      const followedByOther = i < slice.length - 1; // 后面还有消息 → 当前气泡可视为结束

      if (m.role === "assistant") {
        if (this.prefs.text) {
          const clean = sanitizeReplyForQq(m.text || "");
          out.push(
            ...this.consider(m.id + ":text", "text", clean, force || followedByOther),
          );
        }
        if (this.prefs.thinking) {
          const th = String(m.thinking || "")
            .replace(/\u001b\[[0-9;]*m/g, "")
            .trim();
          if (th) {
            out.push(
              ...this.consider(m.id + ":th", "thinking", th, force || followedByOther),
            );
          }
        }
      } else if ((m.role === "tool" || m.role === "toolResult") && this.prefs.tools) {
        const body = sanitizeReplyForQq(m.text || "").slice(0, 1500);
        if (body) {
          // 工具结果一般一次成形
          out.push(...this.consider(m.id + ":tool", "tool", body, true));
        }
      }
    }

    return out;
  }

  flushAll(messages: TrackedMsg[], startIndex: number): OutChunk[] {
    return this.ingest(messages, startIndex, true);
  }

  private consider(
    key: string,
    kind: StreamKind,
    full: string,
    force: boolean,
  ): OutChunk[] {
    const text = full.trim();
    if (!text) return [];

    const already = this.sentFull.get(key) || "";
    if (already === text) return []; // 完全发过

    const prevSeen = this.lastSeen.get(key) || "";
    if (text === prevSeen) {
      this.stableCount.set(key, (this.stableCount.get(key) || 0) + 1);
    } else {
      this.lastSeen.set(key, text);
      this.stableCount.set(key, 1);
    }

    const stable = (this.stableCount.get(key) || 0) >= this.stableNeed;
    // 若只是在原已发送文本上追加，且追加部分已稳定，可发增量整段（新全文 - 但 QQ 用整段新气泡更清晰）
    // 策略：一旦 stable 或 force，发送「尚未发送过的完整当前文本」为一条（若已发过旧版，发新全文）
    if (!stable && !force) return [];

    // 已发送内容是当前文本的前缀且当前更长：只在 force/stable 时发「全文」会重复前缀。
    // 改为：若 already 是 text 前缀，只发后缀（后缀也必须是完整可用文本）；否则发全文一次。
    let payload = text;
    if (already && text.startsWith(already) && text.length > already.length) {
      payload = text.slice(already.length).trim();
      // 后缀若太碎且非 force，等一等
      if (!payload) {
        this.sentFull.set(key, text);
        return [];
      }
      if (!force && payload.length < 8 && !/[。！？!?\n]$/.test(payload)) {
        return [];
      }
    } else if (already && text !== already) {
      // 文本被重写：force 时发新全文，否则等 stable
      if (!force && !stable) return [];
      payload = text;
    }

    if (!payload.trim()) return [];
    // 纯 markdown 垃圾
    if (/^[\s*_\-`>#|]+$/.test(payload.trim())) return [];

    this.sentFull.set(key, text);
    return [this.tag(kind, payload)];
  }

  private tag(kind: StreamKind, text: string): OutChunk {
    let body = text.trim();
    if (kind === "thinking") body = `💭 ${body}`;
    if (kind === "tool") body = `💻 ${body}`;
    this.emittedParts.push(body);
    return { kind, text: body };
  }
}

export function streamStartIndex(
  messages: TrackedMsg[],
  beforeCount: number,
  beforeLastUserId?: string,
): number {
  let start = beforeCount;
  if (beforeLastUserId) {
    for (let i = messages.length - 1; i >= Math.max(0, beforeCount - 1); i--) {
      const m = messages[i];
      if (m.role === "user" && m.id !== beforeLastUserId) {
        start = i + 1;
        break;
      }
    }
  }
  return Math.min(start, messages.length);
}
