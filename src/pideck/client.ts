import { sanitizeReplyForQq } from "../util/reply-text.js";
import {
  StreamTracker,
  streamStartIndex,
  type StreamPrefs,
  DEFAULT_STREAM_PREFS,
} from "../util/stream-emit.js";
/**
 * PiDeck Web Service client.
 *
 * Enable in PiDeck settings:
 *   webServiceEnabled = true
 *   webServicePort = 8765
 *
 * APIs (from PiDeck main process):
 *   GET  /api/health
 *   GET  /api/state
 *   POST /api/agents                 { projectId }
 *   POST /api/agents/:id/prompt      { message }
 *   POST /api/agents/:id/stop
 *   GET  /api/agents/:id/runtime
 */

export interface PiDeckProject {
  id: string;
  name: string;
  path: string;
}

export interface PiDeckAgent {
  id: string;
  title?: string;
  status: string;
  cwd?: string;
  projectId?: string;
  sessionId?: string;
  sessionPath?: string;
  createdAt?: number;
}

export interface PiDeckMessage {
  id: string;
  agentId: string;
  role: "user" | "assistant" | "system" | "tool" | "error" | string;
  text: string;
  timestamp?: number;
  thinking?: string;
}

export interface PiDeckState {
  projects: PiDeckProject[];
  agents: PiDeckAgent[];
  messagesByAgent: Record<string, PiDeckMessage[]>;
}

export interface PiDeckRuntimeState {
  modelName?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  isExecutingTool?: boolean;
  executingToolName?: string;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
}

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiDeckModelInfo {
  id?: string;
  modelId?: string;
  provider?: string;
  name?: string;
  [key: string]: unknown;
}

export class PiDeckClient {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<{ ok: boolean; service?: string }> {
    return this.request("GET", "/api/health");
  }

  async getState(): Promise<PiDeckState> {
    return this.request("GET", "/api/state");
  }

  async createAgent(
    projectId: string,
    options?: { title?: string; sessionPath?: string },
  ): Promise<PiDeckAgent> {
    const data = await this.request<{ agent: PiDeckAgent }>("POST", "/api/agents", {
      projectId,
      ...(options?.title ? { title: options.title } : {}),
      ...(options?.sessionPath ? { sessionPath: options.sessionPath } : {}),
    });
    if (!data.agent?.id) throw new Error("PiDeck createAgent 未返回 agent.id");
    return data.agent;
  }

  async renameAgent(agentId: string, name: string): Promise<PiDeckAgent | undefined> {
    try {
      const data = await this.request<{ agent?: PiDeckAgent }>(
        "POST",
        `/api/agents/${encodeURIComponent(agentId)}/rename`,
        { name },
      );
      return data.agent;
    } catch (err) {
      // older PiDeck without rename API
      console.warn(
        `[pideck] rename failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  async sendPrompt(
    agentId: string,
    message: string,
    images?: PromptImage[],
    options?: { streamingBehavior?: "steer" | "followUp" },
  ): Promise<void> {
    await this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/prompt`, {
      message,
      ...(images && images.length ? { images } : {}),
      ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
    });
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/stop`, {});
  }

  async getMessages(agentId: string): Promise<PiDeckMessage[]> {
    const state = await this.getState();
    return state.messagesByAgent[agentId] ?? [];
  }

  async getAgent(agentId: string): Promise<PiDeckAgent | undefined> {
    const state = await this.getState();
    return state.agents.find((a) => a.id === agentId);
  }

  async getRuntime(agentId: string): Promise<PiDeckRuntimeState> {
    const data = await this.request<{ state: PiDeckRuntimeState }>(
      "GET",
      `/api/agents/${encodeURIComponent(agentId)}/runtime`,
    );
    return data.state ?? {};
  }

  async listModels(agentId: string): Promise<PiDeckModelInfo[]> {
    const data = await this.request<{ models: PiDeckModelInfo[] }>(
      "GET",
      `/api/agents/${encodeURIComponent(agentId)}/models`,
    );
    return Array.isArray(data.models) ? data.models : [];
  }

  async setModel(agentId: string, provider: string, modelId: string): Promise<PiDeckRuntimeState> {
    const data = await this.request<{ state: PiDeckRuntimeState }>(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/model`,
      { provider, modelId },
    );
    return data.state ?? {};
  }

  async cycleModel(agentId: string): Promise<PiDeckRuntimeState> {
    const data = await this.request<{ state: PiDeckRuntimeState }>(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/cycle-model`,
      {},
    );
    return data.state ?? {};
  }

  async setThinking(agentId: string, level: string): Promise<PiDeckRuntimeState> {
    const data = await this.request<{ state: PiDeckRuntimeState }>(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/thinking`,
      { level },
    );
    return data.state ?? {};
  }

  async cycleThinking(agentId: string): Promise<PiDeckRuntimeState> {
    const data = await this.request<{ state: PiDeckRuntimeState }>(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/cycle-thinking`,
      {},
    );
    return data.state ?? {};
  }

  /** Fire-and-forget style prompt for extension commands like /plan */
  async sendCommand(agentId: string, message: string): Promise<void> {
    await this.sendPrompt(agentId, message);
  }

  /**
   * Send a prompt to a PiDeck dialog and wait until the agent becomes idle,
   * then return the latest assistant text produced after the prompt.
   */
  async promptAndWait(
    agentId: string,
    message: string,
    options?: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
      onStatus?: (status: string) => void;
      /** 流式输出块（已按句切好） */
      onStreamChunk?: (chunk: { kind: string; text: string }) => void | Promise<void>;
      streamPrefs?: StreamPrefs;
      images?: PromptImage[];
      streamingBehavior?: "steer" | "followUp";
    },
  ): Promise<string> {
    const pollIntervalMs = Math.min(options?.pollIntervalMs ?? 500, 500);
    const timeoutMs = options?.timeoutMs ?? 600_000;
    const prefs = options?.streamPrefs ?? DEFAULT_STREAM_PREFS;
    const tracker = new StreamTracker(prefs);

    const before = await this.getMessages(agentId);
    const beforeCount = before.length;
    const beforeLastAssistantId = [...before].reverse().find((m) => m.role === "assistant")?.id;
    const beforeLastUserId = [...before].reverse().find((m) => m.role === "user")?.id;

    await this.sendPrompt(agentId, message, options?.images, {
      streamingBehavior: options?.streamingBehavior,
    });

    const started = Date.now();
    let sawRunning = false;
    let idleSince: number | null = null;
    const IDLE_MS = 2000; // 连续空闲 2s 才结束，避免工具间隙误判
    let anyStreamed = false;

    const toTracked = (msgs: PiDeckMessage[]) =>
      msgs.map((m) => ({
        role: m.role,
        id: m.id,
        text: m.text,
        thinking: m.thinking,
      }));

    const pump = async (msgs: PiDeckMessage[], forceFlush = false) => {
      if (!options?.onStreamChunk) return;
      const start = streamStartIndex(toTracked(msgs), beforeCount, beforeLastUserId);
      const tracked = toTracked(msgs);
      const chunks = forceFlush
        ? tracker.flushAll(tracked, start)
        : tracker.ingest(tracked, start);
      for (const c of chunks) {
        if (!c.text?.trim()) continue;
        anyStreamed = true;
        await options.onStreamChunk(c);
      }
    };

    const finish = async (reason: string) => {
      const msgs = await this.getMessages(agentId);
      await pump(msgs, true);
      const partial = extractAssistantReply(msgs, beforeCount, beforeLastAssistantId, beforeLastUserId);
      const rest = remainingFinal(
        partial,
        tracker.getEmittedTotal(),
        anyStreamed,
        tracker.getEmittedCompact(),
      );
      console.log(
        `[pideck] prompt finish reason=${reason} streamed=${anyStreamed} rest_len=${rest.length}`,
      );
      return rest;
    };

    try {
      while (true) {
        if (options?.signal?.aborted) {
          return await finish("aborted");
        }
        if (Date.now() - started > timeoutMs) {
          return await finish("timeout");
        }

        const state = await this.getState();
        const agent = state.agents.find((a) => a.id === agentId);
        if (!agent) throw new Error(`PiDeck agent 不存在: ${agentId}`);

        options?.onStatus?.(agent.status);
        if (agent.status === "running") {
          sawRunning = true;
          idleSince = null;
        }
        if (agent.status === "error") {
          const msgs = state.messagesByAgent[agentId] ?? [];
          const err = [...msgs].reverse().find((m) => m.role === "error");
          throw new Error(err?.text || "PiDeck agent 进入 error 状态");
        }

        const msgs = state.messagesByAgent[agentId] ?? [];
        await pump(msgs, false);

        let tooling = false;
        try {
          const rt = await this.getRuntime(agentId);
          tooling = Boolean(rt.isStreaming || rt.isCompacting || rt.isExecutingTool);
        } catch {
          tooling = false;
        }

        const idleLike =
          agent.status === "idle" || agent.status === "ready" || agent.status === "done";

        if (idleLike && !tooling) {
          if (idleSince == null) idleSince = Date.now();
          const idleFor = Date.now() - idleSince;
          const quickDone = !sawRunning && Date.now() - started > 2500;
          if (idleFor >= IDLE_MS || quickDone) {
            const rest = await finish(sawRunning ? "idle" : "idle-quick");
            if (rest || anyStreamed || sawRunning || Date.now() - started > 2500) {
              return rest;
            }
          }
        } else {
          idleSince = null;
        }

        try {
          await sleep(pollIntervalMs, options?.signal);
        } catch {
          // sleep 被 abort 唤醒时必须走 finish，否则已生成正文不会 flush
          if (options?.signal?.aborted) {
            return await finish("aborted-sleep");
          }
          throw new Error("等待被中断");
        }
      }
    } catch (err) {
      if (options?.signal?.aborted) {
        return await finish("aborted-catch");
      }
      throw err;
    }
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(
        `无法连接 PiDeck Web Service (${url}). 请确认 PiDeck 已打开，并在设置里开启 Web 服务。原始错误: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const msg = data?.error || data?.message || text || res.statusText;
      throw new Error(`PiDeck API ${method} ${path} -> ${res.status}: ${msg}`);
    }
    return data as T;
  }
}

/** 最终回答里还没流式发出去的部分 */
function remainingFinal(
  finalText: string,
  emitted: string,
  anyStreamed: boolean,
  emittedCompact?: string,
): string {
  const final = sanitizeReplyForQq(finalText || "");
  if (!final) return anyStreamed ? "" : "(空回复)";
  if (!anyStreamed) return final;

  const compact = (s: string) => s.replace(/\s+/g, "");
  const fc = compact(final);
  const ec = emittedCompact || compact(emitted);
  if (!fc) return "";
  // 最终全文已发过
  if (ec.includes(fc)) return "";
  // 最终回答作为独立气泡几乎总应补发（中间状态句 != 最终结论）
  // 若相似度很高（>80% 切片命中）则跳过
  let hit = 0;
  const step = 16;
  for (let i = 0; i + step <= fc.length; i += step) {
    if (ec.includes(fc.slice(i, i + step))) hit += step;
  }
  if (fc.length > 0 && hit / fc.length >= 0.92) return "";
  // 中断/收尾：宁可补发完整最终段，也不要丢结论
  return final;
}

function extractAssistantReply(
  messages: PiDeckMessage[],
  beforeCount: number,
  beforeLastAssistantId?: string,
  beforeLastUserId?: string,
): string {
  // 只看本次 prompt 之后新增的消息
  let start = Math.min(beforeCount, messages.length);
  // 若能定位到新 user 消息，从它之后取 assistant
  if (beforeLastUserId) {
    const idx = messages.findIndex((m, i) => i >= beforeCount - 1 && m.role === "user" && m.id !== beforeLastUserId);
    // find last user after beforeCount-1
    for (let i = messages.length - 1; i >= Math.max(0, beforeCount - 1); i--) {
      const m = messages[i];
      if (m.role === "user" && m.id !== beforeLastUserId) {
        start = i + 1;
        break;
      }
    }
  } else {
    start = beforeCount;
  }

  const newer = messages.slice(start);
  let assistants = newer.filter((m) => m.role === "assistant" && m.text?.trim());
  if (beforeLastAssistantId) {
    assistants = assistants.filter((m) => m.id !== beforeLastAssistantId);
  }

  if (assistants.length) {
    // 取最后一条助手文本（工具循环后的最终回答）
    const pick = assistants.at(-1)!;
    return sanitizeReplyForQq(pick.text || "");
  }

  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.text?.trim());
  if (last && last.id !== beforeLastAssistantId) return sanitizeReplyForQq(last.text);
  return "";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("已取消"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
