import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { sanitizeReplyForQq } from "../util/reply-text.js";
import type { PromptImage } from "../util/attachments.js";

export interface SessionPoolOptions {
  cwd: string;
  agentDir: string;
  sessionDir: string;
}

interface PoolEntry {
  key: string;
  session: AgentSession;
  busy: boolean;
  lastUsedAt: number;
}

export class PiSessionPool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(private readonly opts: SessionPoolOptions) {
    mkdirSync(opts.sessionDir, { recursive: true });
  }

  async withSession<T>(
    key: string,
    fn: (session: AgentSession) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "busy" }> {
    const entry = await this.getOrCreate(key);
    if (entry.busy) return { ok: false, reason: "busy" };
    entry.busy = true;
    entry.lastUsedAt = Date.now();
    try {
      const value = await fn(entry.session);
      return { ok: true, value };
    } finally {
      entry.busy = false;
      entry.lastUsedAt = Date.now();
    }
  }

  async reset(key: string): Promise<void> {
    const existing = this.entries.get(key);
    if (existing) {
      try {
        existing.session.dispose();
      } catch {
        // ignore
      }
      this.entries.delete(key);
    }
    await this.getOrCreate(key, true);
  }

  async disposeAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      try {
        entry.session.dispose();
      } catch {
        // ignore
      }
    }
    this.entries.clear();
  }

  private userSessionDir(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "default";
    const dir = join(this.opts.sessionDir, safe);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async getOrCreate(key: string, forceNew = false): Promise<PoolEntry> {
    if (!forceNew) {
      const existing = this.entries.get(key);
      if (existing) return existing;
    }

    const sessionDir = this.userSessionDir(key);
    const sessionManager = forceNew
      ? SessionManager.create(this.opts.cwd, sessionDir)
      : SessionManager.continueRecent(this.opts.cwd, sessionDir);

    const { session } = await createAgentSession({
      cwd: this.opts.cwd,
      agentDir: this.opts.agentDir,
      sessionManager,
    });

    const entry: PoolEntry = {
      key,
      session,
      busy: false,
      lastUsedAt: Date.now(),
    };
    this.entries.set(key, entry);
    console.log(`[pi] session ready key=${key} file=${session.sessionFile ?? "(none)"}`);
    return entry;
  }
}

/** Collect assistant text produced during one prompt() call. */
export async function runPromptAndCollectText(
  session: AgentSession,
  text: string,
  images?: PromptImage[],
): Promise<string> {
  const parts: string[] = [];
  let currentAssistant = "";

  const unsub = session.subscribe((event) => {
    if (event.type === "message_update") {
      const am = event.assistantMessageEvent as { type?: string; delta?: string };
      if (am?.type === "text_delta" && typeof am.delta === "string") {
        currentAssistant += am.delta;
      }
      return;
    }
    if (event.type === "message_end") {
      const msg = event.message as {
        role?: string;
        content?: Array<{ type?: string; text?: string }> | string;
      };
      if (msg?.role === "assistant") {
        const extracted = extractText(msg.content);
        if (extracted) {
          parts.push(extracted);
        } else if (currentAssistant.trim()) {
          parts.push(currentAssistant.trim());
        }
        currentAssistant = "";
      }
    }
  });

  try {
    await session.prompt(text, images && images.length ? { images } : undefined);
  } finally {
    unsub();
  }

  if (currentAssistant.trim()) parts.push(currentAssistant.trim());

  // Prefer the last assistant text block (final answer after tool loops)
  const finalText = parts.filter(Boolean).at(-1) || "";
  return sanitizeReplyForQq(finalText);
}

function extractText(
  content: Array<{ type?: string; text?: string }> | string | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  return content
    .filter((c) => c && (c.type === "text" || c.text))
    .map((c) => c.text || "")
    .join("")
    .trim();
}
