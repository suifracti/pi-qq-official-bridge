import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PiDeckClient, type PromptImage, type PiDeckAgent } from "./client.js";
import type { StreamPrefs } from "../util/stream-emit.js";

export type NewDialogReason =
  | "first"
  | "missing"
  | "error"
  | "idle"
  | "context_full"
  | "explicit"
  | "title_mismatch";

export class NeedDialogSelectError extends Error {
  readonly code = "need_select" as const;
  constructor(
    readonly reason: NewDialogReason,
    readonly previousAgentId?: string,
  ) {
    super(`need_select:${reason}`);
    this.name = "NeedDialogSelectError";
  }
}

interface BindingEntry {
  agentId: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  messageCountApprox?: number;
  /**
   * 用户已确认使用该对话框（/对话框 选择 或 /新会话）。
   * 未确认时禁止自动跑消息。
   */
  confirmed?: boolean;
}

interface BindingStore {
  version: 2;
  /** qq session key -> binding */
  bindings: Record<string, BindingEntry>;
}

export interface SessionPolicy {
  /**
   * 空闲超过该毫秒则新开对话框。0 = 永不因空闲新开。
   * 默认 12 小时。
   */
  idleNewSessionMs: number;
  /**
   * 上下文占用超过该百分比（0-100）则新开。0 = 关闭。
   * 默认 92。
   */
  contextFullPercent: number;
  /** 创建时是否设置/纠正标题 */
  setTitle: boolean;
}

const DEFAULT_POLICY: SessionPolicy = {
  idleNewSessionMs: 12 * 60 * 60 * 1000,
  contextFullPercent: 92,
  setTitle: true,
};

/**
 * One QQ conversation (user / group+user) maps to one PiDeck agent dialog.
 *
 * 新开对话框判断：
 * 1. 首次 / 无绑定
 * 2. 绑定的 agent 已删除或 error
 * 3. 空闲过久（idleNewSessionMs）
 * 4. 上下文将满（contextFullPercent）
 * 5. 用户显式 /新会话
 *
 * 否则复用已有对话框。
 */
export class PiDeckAgentPool {
  private readonly bindings: BindingStore;
  private readonly busy = new Set<string>();
  /** sessionKey -> 当前运行的 AbortController */
  private readonly activeRuns = new Map<string, AbortController>();
  /** sessionKey -> agentId 当前运行 */
  private readonly activeAgentByKey = new Map<string, string>();
  private readonly policy: SessionPolicy;

  constructor(
    private readonly client: PiDeckClient,
    private readonly projectId: string,
    private readonly storePath: string,
    private readonly titlePrefix = "QQ",
    policy?: Partial<SessionPolicy>,
  ) {
    this.bindings = loadStore(storePath);
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  isBusy(key: string): boolean {
    return this.busy.has(key);
  }

  getClient(): PiDeckClient {
    return this.client;
  }

  /** 最近一次列出的对话框，供用户按序号选择 */
  private readonly listCache = new Map<string, { at: number; ids: string[] }>();

  /** 当前绑定 */
  getBinding(key: string): BindingEntry | undefined {
    return this.bindings.bindings[key];
  }

  /**
   * 列出 PiDeck 中可选对话框（当前项目）。
   * 返回给 QQ 展示的文本，并缓存序号→agentId。
   */
  async buildSelectPrompt(key: string, reason?: NewDialogReason): Promise<string> {
    const why =
      reason === "idle"
        ? "当前对话空闲较久，请确认还用哪个对话框："
        : reason === "context_full"
          ? "当前对话上下文将满，请换一个或新建："
          : reason === "missing" || reason === "error"
            ? "原对话框不可用，请重新选择："
            : "尚未绑定对话框，请先选择（不会自动开跑）：";
    const list = await this.listDialogs(key);
    return `${why}\n\n${list}`;
  }

  async listDialogs(key: string): Promise<string> {
    const state = await this.client.getState();
    const agents = state.agents
      .filter((a) => !a.projectId || a.projectId === this.projectId)
      .filter((a) => a.status !== "error")
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const current = this.bindings.bindings[key]?.agentId;
    const ids = agents.map((a) => a.id);
    this.listCache.set(key, { at: Date.now(), ids });

    if (!agents.length) {
      return "PiDeck 里还没有对话框。\n发送 /新会话 创建一个，或在桌面新建后再 /对话框。";
    }

    const lines = ["请选择要使用的 PiDeck 对话框：", "回复序号即可，例如：1", "或：/对话框 1  /新会话", ""];
    agents.forEach((a, i) => {
      const mark = a.id === current ? " ←当前" : "";
      const title = (a.title || "(无标题)").replace(/\s+/g, " ").slice(0, 40);
      const st = a.status || "?";
      lines.push(`${i + 1}. [${st}] ${title}${mark}`);
      lines.push(`   id=${a.id.slice(0, 8)}…`);
    });
    if (current && !ids.includes(current)) {
      lines.push("", `当前绑定的对话框已不存在，请选一个或 /新会话。`);
    }
    return lines.join("\n");
  }

  /**
   * 按列表序号或 agentId 前缀绑定到已有对话框。
   */
  async selectDialog(
    key: string,
    query: string,
    displayName?: string,
  ): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
    const q = query.trim();
    if (!q) {
      return { ok: false, text: await this.listDialogs(key) };
    }

    const state = await this.client.getState();
    const agents = state.agents.filter(
      (a) => (!a.projectId || a.projectId === this.projectId) && a.status !== "error",
    );

    let chosen = agents.find((a) => a.id === q || a.id.startsWith(q));

    // 数字序号
    if (!chosen && /^\d+$/.test(q)) {
      const n = Number(q);
      const cache = this.listCache.get(key);
      // 缓存 10 分钟内有效；否则按当前列表
      const ids =
        cache && Date.now() - cache.at < 10 * 60 * 1000
          ? cache.ids
          : agents
              .slice()
              .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
              .map((a) => a.id);
      const id = ids[n - 1];
      if (!id) {
        return {
          ok: false,
          text: `序号 ${n} 无效。请先 /对话框 查看列表。`,
        };
      }
      chosen = agents.find((a) => a.id === id) || (await this.client.getAgent(id));
    }

    // 标题模糊
    if (!chosen) {
      const lower = q.toLowerCase();
      const hits = agents.filter((a) => (a.title || "").toLowerCase().includes(lower));
      if (hits.length === 1) chosen = hits[0];
      else if (hits.length > 1) {
        const lines = ["匹配到多个对话框，请用序号选择：", ""];
        const ids = hits.map((a) => a.id);
        this.listCache.set(key, { at: Date.now(), ids });
        hits.forEach((a, i) => {
          lines.push(`${i + 1}. ${a.title || a.id.slice(0, 8)}`);
        });
        return { ok: false, text: lines.join("\n") };
      }
    }

    if (!chosen) {
      return { ok: false, text: `未找到对话框：${q}\n先发 /对话框 查看列表。` };
    }

    const title = this.buildTitle(key, displayName);
    const now = Date.now();
    this.bindings.bindings[key] = {
      agentId: chosen.id,
      title: chosen.title || title,
      createdAt: now,
      lastActiveAt: now,
      confirmed: true,
    };
    this.persist();

    console.log(`[pideck] bind key=${key} -> agent=${chosen.id} title=${chosen.title}`);
    return {
      ok: true,
      text: [
        "已切换对话框",
        `标题: ${chosen.title || "(无标题)"}`,
        `状态: ${chosen.status}`,
        `id: ${chosen.id.slice(0, 8)}…`,
        "",
        "之后消息会进这个 PiDeck 对话框。",
      ].join("\n"),
    };
  }

  /** 当前绑定摘要 */
  async currentDialogText(key: string): Promise<string> {
    const b = this.bindings.bindings[key];
    if (!b) return "当前未绑定对话框。发 /对话框 选择，或 /新会话 创建。";
    const agent = await this.client.getAgent(b.agentId);
    if (!agent) return `绑定已失效（${b.agentId.slice(0, 8)}…）。请 /对话框 重选。`;
    return [
      "当前对话框",
      `标题: ${agent.title || "(无标题)"}`,
      `状态: ${agent.status}`,
      `id: ${agent.id.slice(0, 8)}…`,
      `上次活跃: ${new Date(b.lastActiveAt).toLocaleString()}`,
    ].join("\n");
  }

  async ensure(key: string, displayName?: string): Promise<string> {
    const { agentId } = await this.ensureAgent(key, displayName);
    return agentId;
  }

  async prompt(
    key: string,
    message: string,
    options?: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      displayName?: string;
      images?: PromptImage[];
      streamPrefs?: StreamPrefs;
      onStreamChunk?: (chunk: { kind: string; text: string }) => void | Promise<void>;
    },
  ): Promise<
    | { ok: true; text: string; agentId: string; reason?: NewDialogReason; steered?: boolean }
    | { ok: false; reason: "busy" }
  > {
    // 任务运行中再发消息 = 引导（steer），不报忙、不另开等待
    if (this.busy.has(key)) {
      const binding = this.bindings.bindings[key];
      if (!binding?.agentId) return { ok: false, reason: "busy" };
      const agent = await this.client.getAgent(binding.agentId);
      if (agent && agent.status === "running") {
        await this.client.sendPrompt(binding.agentId, message, options?.images, {
          streamingBehavior: "steer",
        });
        console.log(`[pideck] steer key=${key} agent=${binding.agentId}`);
        return {
          ok: true,
          text: "已作为引导发送到当前任务。",
          agentId: binding.agentId,
          steered: true,
        };
      }
      // 本地锁还在但 agent 已空闲：视为忙冲突（极短窗口）
      return { ok: false, reason: "busy" };
    }

    this.busy.add(key);
    const ac = new AbortController();
    this.activeRuns.set(key, ac);
    try {
      const { agentId, reason } = await this.ensureAgent(key, options?.displayName);
      this.activeAgentByKey.set(key, agentId);
      // 若 agent 已在跑（例如桌面侧触发），也走引导
      const agent = await this.client.getAgent(agentId);
      if (agent?.status === "running") {
        await this.client.sendPrompt(agentId, message, options?.images, {
          streamingBehavior: "steer",
        });
        console.log(`[pideck] steer(no-lock) key=${key} agent=${agentId}`);
        return {
          ok: true,
          text: "已作为引导发送到当前任务。",
          agentId,
          steered: true,
        };
      }

      const text = await this.client.promptAndWait(agentId, message, {
        pollIntervalMs: options?.pollIntervalMs,
        timeoutMs: options?.timeoutMs,
        images: options?.images,
        streamPrefs: options?.streamPrefs,
        onStreamChunk: options?.onStreamChunk,
        signal: ac.signal,
      });
      this.touch(key, agentId);
      return { ok: true, text, agentId, reason };
    } finally {
      this.busy.delete(key);
      this.activeRuns.delete(key);
      this.activeAgentByKey.delete(key);
    }
  }

  /** 中断当前任务：abort 等待循环（会 flush 已生成正文）并 stop agent */
  async interrupt(key: string): Promise<{ agentId?: string; aborted: boolean }> {
    const ac = this.activeRuns.get(key);
    const agentId = this.activeAgentByKey.get(key) || this.bindings.bindings[key]?.agentId;
    let aborted = false;
    // 1) 先 abort 等待循环 → finish() flush 已生成正文到 QQ
    if (ac && !ac.signal.aborted) {
      ac.abort();
      aborted = true;
      // 给 finish/pump 一点时间把剩余气泡推完
      await new Promise((r) => setTimeout(r, 600));
    }
    // 2) 再 stop agent（若仍在跑）
    if (agentId) {
      try {
        await this.client.stopAgent(agentId);
      } catch {
        // ignore
      }
      // stop 后再等一轮，让 idle 后的最终 assistant 气泡（若有）被原 wait 的 finish 吃到
      await new Promise((r) => setTimeout(r, 400));
    }
    return { agentId, aborted };
  }

  /** 用户显式要求新会话 */
  async reset(key: string, displayName?: string): Promise<string> {
    return this.openNew(key, displayName, "explicit");
  }

  /**
   * 核心判断：该复用还是新开。
   */
  async decide(
    key: string,
    displayName?: string,
  ): Promise<
    | { action: "reuse"; agentId: string; agent: PiDeckAgent; binding: BindingEntry }
    | { action: "need_select"; reason: NewDialogReason; previousAgentId?: string }
  > {
    const title = this.buildTitle(key, displayName);
    const binding = this.bindings.bindings[key];

    if (!binding?.agentId) {
      return { action: "need_select", reason: "first" };
    }

    const agent = await this.client.getAgent(binding.agentId);
    if (!agent) {
      return { action: "need_select", reason: "missing", previousAgentId: binding.agentId };
    }
    if (agent.status === "error") {
      return { action: "need_select", reason: "error", previousAgentId: binding.agentId };
    }

    // 从未被用户确认（选择/新会话）→ 必须先问
    if (!binding.confirmed) {
      return { action: "need_select", reason: "first", previousAgentId: binding.agentId };
    }

    const now = Date.now();
    // 空闲过久：再确认，不自动新开乱跑
    if (
      this.policy.idleNewSessionMs > 0 &&
      binding.lastActiveAt > 0 &&
      now - binding.lastActiveAt > this.policy.idleNewSessionMs
    ) {
      return { action: "need_select", reason: "idle", previousAgentId: binding.agentId };
    }

    // 上下文将满：提示用户换/新开
    if (this.policy.contextFullPercent > 0) {
      try {
        const runtime = await this.client.getRuntime(binding.agentId);
        const pct = runtime.contextPercent;
        if (typeof pct === "number" && pct >= this.policy.contextFullPercent) {
          return { action: "need_select", reason: "context_full", previousAgentId: binding.agentId };
        }
      } catch {
        // ignore
      }
    }

    return { action: "reuse", agentId: binding.agentId, agent, binding: { ...binding, title } };
  }

  private async ensureAgent(
    key: string,
    displayName?: string,
  ): Promise<{ agentId: string; reason?: NewDialogReason }> {
    const decision = await this.decide(key, displayName);
    if (decision.action === "reuse") {
      // 用户已确认的对话框可轻量纠正标题
      if (this.policy.setTitle && decision.binding.confirmed) {
        const want = this.buildTitle(key, displayName);
        if (decision.agent.title !== want && (decision.agent.title || "").startsWith(this.titlePrefix)) {
          try {
            await this.client.renameAgent(decision.agentId, want);
            const b = this.bindings.bindings[key];
            if (b) {
              b.title = want;
              this.persist();
            }
          } catch {
            // ignore
          }
        }
      }
      console.log(
        `[pideck] reuse dialog key=${key} agent=${decision.agentId} status=${decision.agent.status}`,
      );
      return { agentId: decision.agentId };
    }

    // 不再自动创建；由 bridge 询问用户
    throw new NeedDialogSelectError(decision.reason, decision.previousAgentId);
  }

  private async openNew(key: string, displayName: string | undefined, reason: NewDialogReason): Promise<string> {
    const title = this.buildTitle(key, displayName);
    // 清旧绑定
    delete this.bindings.bindings[key];
    this.persist();

    const agent = await this.client.createAgent(this.projectId, { title });
    if (this.policy.setTitle && agent.title !== title) {
      try {
        await this.client.renameAgent(agent.id, title);
      } catch {
        // ignore
      }
    }

    const now = Date.now();
    this.bindings.bindings[key] = {
      agentId: agent.id,
      title,
      createdAt: now,
      lastActiveAt: now,
      confirmed: reason === "explicit",
    };
    this.persist();
    console.log(`[pideck] opened dialog reason=${reason} key=${key} agent=${agent.id} title=${title}`);
    return agent.id;
  }

  private touch(key: string, agentId: string): void {
    const b = this.bindings.bindings[key];
    if (!b) {
      // 无绑定不应通过 touch 隐式确认
      this.bindings.bindings[key] = {
        agentId,
        title: this.buildTitle(key),
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        messageCountApprox: 1,
        confirmed: false,
      };
    } else {
      b.agentId = agentId;
      b.lastActiveAt = Date.now();
      b.messageCountApprox = (b.messageCountApprox || 0) + 1;
    }
    this.persist();
  }

  /**
   * 标题尽量稳定且可区分：
   * - 群: QQ · 用户名 · gXXXX
   * - 私聊: QQ · 用户名
   */
  private buildTitle(key: string, displayName?: string): string {
    const name = (displayName || "").trim() || shortKey(key);
    if (key.startsWith("group:")) {
      const parts = key.split(":");
      const gid = (parts[1] || "").slice(0, 6);
      return `${this.titlePrefix} · ${name} · g${gid}`;
    }
    if (key.startsWith("channel:")) {
      const parts = key.split(":");
      const cid = (parts[1] || "").slice(0, 6);
      return `${this.titlePrefix} · ${name} · c${cid}`;
    }
    return `${this.titlePrefix} · ${name}`;
  }

  private persist(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, `${JSON.stringify(this.bindings, null, 2)}\n`, "utf8");
  }
}

function shortKey(key: string): string {
  return key.replace(/^(c2c|group|channel):/, "").slice(0, 12) || "user";
}

function loadStore(path: string): BindingStore {
  if (!existsSync(path)) return { version: 2, bindings: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as any;
    if (!raw || typeof raw !== "object") return { version: 2, bindings: {} };

    // v1: bindings: Record<string, string>
    const bindingsIn = raw.bindings && typeof raw.bindings === "object" ? raw.bindings : {};
    const out: Record<string, BindingEntry> = {};
    const now = Date.now();
    for (const [k, v] of Object.entries(bindingsIn)) {
      if (typeof v === "string") {
        out[k] = {
          agentId: v,
          title: "",
          createdAt: now,
          lastActiveAt: now,
        };
      } else if (v && typeof v === "object" && typeof (v as any).agentId === "string") {
        const e = v as Partial<BindingEntry>;
        out[k] = {
          agentId: e.agentId!,
          title: typeof e.title === "string" ? e.title : "",
          createdAt: typeof e.createdAt === "number" ? e.createdAt : now,
          lastActiveAt: typeof e.lastActiveAt === "number" ? e.lastActiveAt : now,
          messageCountApprox: e.messageCountApprox,
          confirmed: Boolean((e as any).confirmed ?? (e as any).userPinned),
        };
      }
    }
    return { version: 2, bindings: out };
  } catch {
    return { version: 2, bindings: {} };
  }
}
