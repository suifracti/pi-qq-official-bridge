import { resolve } from "node:path";
import type { BridgeConfig } from "./config.js";
import { buildIntents } from "./config.js";
import { QqAccessToken } from "./qq/token.js";
import { QqApi, type SendTarget } from "./qq/api.js";
import { QqGateway, type IncomingQqMessage } from "./qq/gateway.js";
import { PiSessionPool, runPromptAndCollectText } from "./pi/session-pool.js";
import { PiDeckClient } from "./pideck/client.js";
import { NeedDialogSelectError, PiDeckAgentPool } from "./pideck/agent-pool.js";
import { helpCommandText, parseCommand, runPideckCommand } from "./commands.js";
import {
  downloadQqMedia,
  toPromptImages,
  type DownloadedMedia,
} from "./util/attachments.js";
import { extractSendFiles, sanitizeReplyForQq } from "./util/reply-text.js";
import {
  DEFAULT_STREAM_PREFS,
  type StreamPrefs,
} from "./util/stream-emit.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export class PiQqBridge {
  private readonly token: QqAccessToken;
  private readonly api: QqApi;
  private gateway: QqGateway | null = null;
  private readonly nextSeqByMsgId = new Map<string, number>();
  /** 等待用户选择对话框时暂存的消息 */
  private readonly pendingByKey = new Map<
    string,
    {
      text: string;
      media: { images: DownloadedMedia[]; files: DownloadedMedia[] };
      displayName: string;
      at: number;
    }
  >();

  private streamPrefs: StreamPrefs = { ...DEFAULT_STREAM_PREFS };


  private sdkPool: PiSessionPool | null = null;
  private deckClient: PiDeckClient | null = null;
  private deckPool: PiDeckAgentPool | null = null;

  constructor(private readonly cfg: BridgeConfig) {
    this.token = new QqAccessToken(cfg.appId, cfg.clientSecret);
    this.api = new QqApi(this.token, cfg.sandbox);

    if (cfg.backend === "sdk") {
      this.sdkPool = new PiSessionPool(cfg.pi);
    } else {
      this.deckClient = new PiDeckClient(cfg.pideck.baseUrl);
      this.deckPool = new PiDeckAgentPool(
        this.deckClient,
        cfg.pideck.projectId,
        resolve(cfg.pideck.bindingsPath),
        cfg.pideck.titlePrefix,
        {
          idleNewSessionMs: cfg.pideck.idleNewSessionMs,
          contextFullPercent: cfg.pideck.contextFullPercent,
        },
      );
    }
    this.streamPrefs = this.loadStreamPrefs();
  }

  async start(): Promise<void> {
    if (this.cfg.backend === "pideck" && this.deckClient) {
      await this.ensurePiDeckReady();
    }

    const intents = buildIntents(this.cfg.intents);
    console.log(`[bridge] starting backend=${this.cfg.backend} intents=${intents}`);
    this.gateway = new QqGateway(this.token, this.api, intents, (msg) => this.handleMessage(msg));
    await this.gateway.start();
  }

  private async ensurePiDeckReady(): Promise<void> {
    if (!this.deckClient) return;
    const maxAttempts = Number(process.env.PIDEEK_WAIT_ATTEMPTS || 15);
    const delayMs = Number(process.env.PIDEEK_WAIT_MS || 2000);

    for (let i = 1; i <= maxAttempts; i++) {
      try {
        const health = await this.deckClient.health();
        console.log(
          `[bridge] PiDeck connected: ${JSON.stringify(health)} @ ${this.cfg.pideck.baseUrl}`,
        );
        const state = await this.deckClient.getState();
        const project = state.projects.find((p) => p.id === this.cfg.pideck.projectId);
        if (!project) {
          console.warn(
            `[bridge] 警告: projectId=${this.cfg.pideck.projectId} 不在 PiDeck 项目列表中。可用: ${
              state.projects.map((p) => `${p.id}(${p.name})`).join(", ") || "(空)"
            }`,
          );
        } else {
          console.log(`[bridge] PiDeck project: ${project.name} (${project.path})`);
        }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[bridge] 等待 PiDeck Web 服务 (${i}/${maxAttempts}): ${msg}`);
        if (i === 1) {
          console.warn(
            [
              "",
              "PiDeck Web 服务未就绪。请按下面做：",
              "1) 打开 PiDeck → 设置 → 打开「Web 服务」（端口 8765）",
              "2) 或执行: npm run enable-webservice",
              "3) 然后【完全退出 PiDeck 再打开】（只关窗口不够，要从菜单退出）",
              "4) 验证: curl http://127.0.0.1:8765/api/health",
              "",
            ].join("\n"),
          );
        }
        if (i < maxAttempts) await sleep(delayMs);
      }
    }

    throw new Error(
      [
        `无法连接 PiDeck Web Service (${this.cfg.pideck.baseUrl}/api/health)`,
        "请确认 PiDeck 已运行且 Web 服务已开启，并完全重启过。",
      ].join("\n"),
    );
  }

  async stop(): Promise<void> {
    this.gateway?.stop();
    await this.sdkPool?.disposeAll();
  }

  private async handleMessage(msg: IncomingQqMessage): Promise<void> {
    const target = toSendTarget(msg);
    if (!target) {
      console.warn("[bridge] unsupported message target", msg.event);
      return;
    }

    if (!this.isAllowed(msg)) {
      console.log(
        `[bridge] ignore unauthorized user=${msg.authorOpenId} group=${msg.groupOpenId || "-"}`,
      );
      return;
    }

    const text = normalizeUserText(msg.content, this.cfg.bridge.wakePrefix);
    const media = await this.loadMedia(msg);
    const mentionOnly = isMentionOnlyMessage(msg, text, media);

    // 无正文、无附件、且不是纯 @：忽略
    if (!text && media.images.length === 0 && media.files.length === 0 && !mentionOnly) return;

    const sessionKey = buildSessionKey(msg);
    console.log(
      `[bridge] <- ${msg.event} from=${msg.authorOpenId} key=${sessionKey} text=${JSON.stringify(
        (text || (mentionOnly ? "[@]" : "[附件]")).slice(0, 120),
      )} images=${media.images.length} files=${media.files.length} mentionOnly=${mentionOnly}`,
    );

    const displayName = msg.authorUsername || msg.authorOpenId.slice(0, 12);

    // 纯 @ 机器人：启用会话（选对话框 / 报当前状态），不往模型塞空消息
    if (mentionOnly) {
      try {
        const reply = await this.handleMentionOnly(sessionKey, displayName);
        await this.reply(target, msg, reply);
      } catch (err) {
        await this.reply(
          target,
          msg,
          `启动失败: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            this.cfg.bridge.maxReplyChars,
          ),
        );
      }
      return;
    }

    // 等待选对话框时：纯数字直接当选择
    if (
      this.cfg.backend === "pideck" &&
      this.deckPool &&
      this.pendingByKey.has(sessionKey) &&
      text &&
      /^\d+$/.test(text.trim())
    ) {
      try {
        const reply = await this.applyDialogSelection(sessionKey, text.trim(), displayName, target, msg);
        await this.reply(target, msg, reply);
      } catch (err) {
        await this.reply(
          target,
          msg,
          `选择失败: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            this.cfg.bridge.maxReplyChars,
          ),
        );
      }
      return;
    }

    const cmd = text ? parseCommand(text) : null;
    if (cmd) {
      try {
        const reply = await this.handleCommand(sessionKey, msg, cmd);
        // 选对话框/新会话后，若有暂存消息则继续处理
        if (
          this.cfg.backend === "pideck" &&
          this.deckPool &&
          (cmd.type === "dialogs" || cmd.type === "new") &&
          this.pendingByKey.has(sessionKey)
        ) {
          const follow = await this.flushPendingAfterBind(sessionKey, target, msg);
          await this.reply(target, msg, follow ? `${reply}\n\n——\n${follow}` : reply);
        } else {
          await this.reply(target, msg, reply);
        }
      } catch (err) {
        console.error("[bridge] command failed:", err);
        await this.reply(
          target,
          msg,
          `指令失败: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            this.cfg.bridge.maxReplyChars,
          ),
        );
      }
      return;
    }

    // 无绑定/未确认：先问选哪个对话框，暂存本条消息，绝不自动开跑
    if (this.cfg.backend === "pideck" && this.deckPool) {
      const decision = await this.deckPool.decide(sessionKey, displayName);
      if (decision.action === "need_select") {
        this.pendingByKey.set(sessionKey, {
          text,
          media,
          displayName,
          at: Date.now(),
        });
        console.log(`[bridge] need_select reason=${decision.reason} key=${sessionKey} pending=1`);
        const ask = await this.deckPool.buildSelectPrompt(sessionKey, decision.reason);
        await this.reply(target, msg, ask);
        return;
      }
    }

    // 流式模式下不发「处理中」占位，直接推助手正文
    if (this.cfg.bridge.sendThinkingAck) {
      void this.reply(target, msg, this.cfg.bridge.thinkingText).catch(() => undefined);
    }

    try {
      const answer = await this.runBackend(sessionKey, msg, text, media, target);
      if (answer != null && answer !== "") {
        await this.reply(target, msg, answer);
      }
    } catch (err) {
      if (err instanceof NeedDialogSelectError && this.deckPool) {
        this.pendingByKey.set(sessionKey, { text, media, displayName, at: Date.now() });
        const ask = await this.deckPool.buildSelectPrompt(sessionKey, err.reason);
        await this.reply(target, msg, ask);
        return;
      }
      console.error("[bridge] backend failed:", err);
      try {
        await this.reply(
          target,
          msg,
          `${this.cfg.bridge.errorText}\n${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            this.cfg.bridge.maxReplyChars,
          ),
        );
      } catch {
        // ignore
      }
    }
  }

  private async applyDialogSelection(
    sessionKey: string,
    query: string,
    displayName: string,
    target: SendTarget,
    msg: IncomingQqMessage,
  ): Promise<string> {
    if (!this.deckPool) return "PiDeck 未就绪";
    const r = await this.deckPool.selectDialog(sessionKey, query, displayName);
    if (!r.ok) return r.text;
    const follow = await this.flushPendingAfterBind(sessionKey, target, msg);
    return follow ? `${r.text}\n\n——\n${follow}` : r.text;
  }

  /** 绑定成功后处理暂存消息 */
  private async flushPendingAfterBind(
    sessionKey: string,
    target: SendTarget,
    msg: IncomingQqMessage,
  ): Promise<string | null> {
    const pending = this.pendingByKey.get(sessionKey);
    if (!pending) return null;
    // 暂存超过 30 分钟丢弃
    if (Date.now() - pending.at > 30 * 60 * 1000) {
      this.pendingByKey.delete(sessionKey);
      return "（之前的消息已过期，请重新发送）";
    }
    this.pendingByKey.delete(sessionKey);
    console.log(`[bridge] flush pending key=${sessionKey} text=${JSON.stringify(pending.text.slice(0, 80))}`);
    try {
      if (this.cfg.bridge.sendThinkingAck) {
        void this.reply(target, msg, this.cfg.bridge.thinkingText).catch(() => undefined);
      }
      const answer = await this.runBackend(sessionKey, msg, pending.text, pending.media, target);
      return answer || "";
    } catch (err) {
      return `处理暂存消息失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 只 @ 机器人、没有正文时的启用逻辑 */
  private async handleMentionOnly(sessionKey: string, displayName: string): Promise<string> {
    if (this.cfg.backend === "pideck" && this.deckPool) {
      const decision = await this.deckPool.decide(sessionKey, displayName);
      if (decision.action === "need_select") {
        return this.deckPool.buildSelectPrompt(sessionKey, decision.reason);
      }
      const cur = await this.deckPool.currentDialogText(sessionKey);
      return [
        "在，已就绪。",
        cur,
        "",
        "直接发问题即可；/帮助 看指令；/对话框 切换会话；/新会话 新建。",
      ].join("\n");
    }
    return "在。直接发送问题即可。（/帮助）";
  }

  private async loadMedia(
    msg: IncomingQqMessage,
  ): Promise<{ images: DownloadedMedia[]; files: DownloadedMedia[] }> {
    if (!msg.attachments?.length) return { images: [], files: [] };
    try {
      const authorization = await this.api.getAuthorization();
      return await downloadQqMedia(msg.attachments, {
        authorization,
        saveDir: resolve(this.cfg.pi.sessionDir, "media"),
      });
    } catch (err) {
      console.warn(
        `[bridge] load media failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { images: [], files: [] };
    }
  }

  private async handleCommand(
    sessionKey: string,
    msg: IncomingQqMessage,
    cmd: NonNullable<ReturnType<typeof parseCommand>>,
  ): Promise<string> {
    if (cmd.type === "help") {
      return helpCommandText(this.cfg.backend);
    }

    if (cmd.type === "new") {
      if (this.cfg.backend === "pideck" && this.deckPool) {
        const displayName = msg.authorUsername || msg.authorOpenId.slice(0, 12);
        const agentId = await this.deckPool.reset(sessionKey, displayName);
        return `已新开 PiDeck 对话框\nid=${agentId.slice(0, 8)}…`;
      }
      if (this.sdkPool) {
        await this.sdkPool.reset(sessionKey);
        return "已开启新会话。";
      }
      return "无法新建会话。";
    }

    if (cmd.type === "dialogs") {
      if (this.cfg.backend !== "pideck" || !this.deckPool) {
        return "对话框选择仅支持 PiDeck 后端。";
      }
      const displayName = msg.authorUsername || msg.authorOpenId.slice(0, 12);
      if (cmd.action === "list") return this.deckPool.listDialogs(sessionKey);
      if (cmd.action === "current") return this.deckPool.currentDialogText(sessionKey);
      const r = await this.deckPool.selectDialog(sessionKey, cmd.query || "", displayName);
      return r.text;
    }

    // /stop：停当前 PiDeck 响应 + 清暂存，不强制先选对话框
    if (cmd.type === "stop") {
      return this.handleStop(sessionKey);
    }

    if (cmd.type === "stream") {
      return this.handleStreamCommand(cmd);
    }

    if (this.cfg.backend !== "pideck" || !this.deckPool || !this.deckClient) {
      return "当前是 SDK 后端，模型/思考/计划模式请改用 backend=pideck。";
    }

    const displayName = msg.authorUsername || msg.authorOpenId.slice(0, 12);
    const agentId = await this.deckPool.ensure(sessionKey, displayName);
    return runPideckCommand(this.deckClient, agentId, cmd);
  }

  private async handleStop(sessionKey: string): Promise<string> {
    const clearedPending = this.pendingByKey.delete(sessionKey);
    const parts: string[] = [];

    if (this.cfg.backend === "pideck" && this.deckPool) {
      // interrupt：abort 等待循环（强制 flush 已生成正文）+ stop agent
      const r = await this.deckPool.interrupt(sessionKey);
      if (r.agentId) {
        parts.push(
          r.aborted
            ? `已中断，正在输出已生成内容（${r.agentId.slice(0, 8)}…）`
            : `已请求停止（${r.agentId.slice(0, 8)}…）`,
        );
      } else {
        parts.push("当前没有进行中的任务。");
      }
    } else {
      parts.push("SDK 后端暂不支持远程 /stop，请在进程侧中断。");
    }

    if (clearedPending) parts.push("已丢弃暂存待发消息。");
    return parts.join("\n");
  }


  private handleStreamCommand(
    cmd: { action: "show" | "set"; key?: "thinking" | "tools" | "text"; value?: boolean },
  ): string {
    if (cmd.action === "set" && cmd.key) {
      if (cmd.key === "thinking") this.streamPrefs.thinking = Boolean(cmd.value);
      if (cmd.key === "tools") this.streamPrefs.tools = Boolean(cmd.value);
      if (cmd.key === "text") this.streamPrefs.text = Boolean(cmd.value);
      this.saveStreamPrefs();
    }
    const sp = this.streamPrefs;
    return [
      "QQ 流式输出开关：",
      `正文 text: ${sp.text ? "开" : "关"}`,
      `思考 thinking: ${sp.thinking ? "开" : "关"}`,
      `bash/工具 tools: ${sp.tools ? "开" : "关"}`,
      "",
      "用法：",
      "/输出 思考 开",
      "/输出 bash 开",
      "/输出 正文 关",
    ].join("\n");
  }

  private streamPrefsPath(): string {
    return join(homedir(), ".pi", "agent", "qq", "stream-prefs.json");
  }

  private loadStreamPrefs(): StreamPrefs {
    try {
      const fp = this.streamPrefsPath();
      if (!existsSync(fp)) {
        return {
          text: this.cfg.bridge.streamText ?? true,
          thinking: this.cfg.bridge.streamThinking ?? false,
          tools: this.cfg.bridge.streamTools ?? false,
        };
      }
      const raw = JSON.parse(readFileSync(fp, "utf8")) as Partial<StreamPrefs>;
      return {
        text: raw.text !== false,
        thinking: Boolean(raw.thinking),
        tools: Boolean(raw.tools),
      };
    } catch {
      return { ...DEFAULT_STREAM_PREFS };
    }
  }

  private saveStreamPrefs(): void {
    const fp = this.streamPrefsPath();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, `${JSON.stringify(this.streamPrefs, null, 2)}\n`, "utf8");
  }

  private async runBackend(
    sessionKey: string,
    msg: IncomingQqMessage,
    text: string,
    media: { images: DownloadedMedia[]; files: DownloadedMedia[] },
    target?: SendTarget,
  ): Promise<string> {
    // 直接把用户原文送进 PiDeck；附件只附加最短本地路径提示
    const prompt = buildPrompt(text, media);
    const promptImages = toPromptImages(media.images);

    if (this.cfg.backend === "pideck" && this.deckPool) {
      let streamed = false;
      const sendTarget = target ?? toSendTarget(msg);
      const coalescer = sendTarget ? this.createStreamCoalescer(sendTarget, msg) : null;
      const result = await this.deckPool.prompt(sessionKey, prompt, {
        pollIntervalMs: Math.min(this.cfg.pideck.pollIntervalMs, 500),
        timeoutMs: this.cfg.pideck.timeoutMs,
        displayName: msg.authorUsername || msg.authorOpenId.slice(0, 12),
        images: promptImages,
        streamPrefs: this.streamPrefs,
        onStreamChunk: coalescer
          ? async (chunk) => {
              streamed = true;
              try {
                await coalescer.push(chunk.text);
              } catch (err) {
                console.warn(
                  `[bridge] stream reply failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          : undefined,
      });
      if (!result.ok) return this.cfg.bridge.busyText;
      if (result.steered) return result.text;
      // 收尾：刷出合并缓冲 + 最终补发段
      if (coalescer) {
        if (result.text && result.text.trim()) {
          await coalescer.push(result.text);
        }
        await coalescer.flush(true);
        console.log(
          `[bridge] pideck agent=${result.agentId} streamed=${streamed} final_flush=1`,
        );
        return ""; // 已通过 coalescer 发出
      }
      console.log(
        `[bridge] pideck agent=${result.agentId} reply_len=${result.text.length} streamed=${streamed}`,
      );
      if (result.text && result.text.trim()) return result.text;
      if (streamed) return "";
      return "(空回复)";
    }

    if (!this.sdkPool) throw new Error("SDK backend 未初始化");
    const result = await this.sdkPool.withSession(sessionKey, async (session) => {
      return runPromptAndCollectText(session, prompt, promptImages);
    });
    if (!result.ok) return this.cfg.bridge.busyText;
    return result.value || "(模型没有返回文本)";
  }

  private isAllowed(msg: IncomingQqMessage): boolean {
    const { allowOpenIds, allowGroupOpenIds } = this.cfg.bridge;
    if (msg.groupOpenId) {
      if (allowGroupOpenIds.length > 0 && !allowGroupOpenIds.includes(msg.groupOpenId)) {
        return false;
      }
    }
    if (allowOpenIds.length > 0 && !allowOpenIds.includes(msg.authorOpenId)) {
      return false;
    }
    return true;
  }

  /** 每个用户消息的发送预算：QQ 被动回复次数有限 */
  private readonly replyBudget = new Map<
    string,
    { seq: number; passiveLeft: number; forceProactive: boolean }
  >();

  private getBudget(msgId: string): { seq: number; passiveLeft: number; forceProactive: boolean } {
    let b = this.replyBudget.get(msgId);
    if (!b) {
      b = {
        seq: 1 + Math.floor(Math.random() * 1000),
        // QQ 被动回复次数有限；按实际分段数递减，避免长文本误判额度。
        passiveLeft: 3,
        forceProactive: false,
      };
      this.replyBudget.set(msgId, b);
    }
    return b;
  }

  /** 原样转发：合并控制 + 被动超限自动改主动 */
  private async reply(
    target: SendTarget,
    msg: IncomingQqMessage,
    content: string,
    opts?: { isFinal?: boolean },
  ): Promise<void> {
    const { cleanText, files } = extractSendFiles(content);
    const cleaned = sanitizeReplyForQq(cleanText);
    const budget = this.getBudget(msg.id);

    if (cleaned) {
      const usePassive = !budget.forceProactive && budget.passiveLeft > 0;
      try {
        const r = await this.api.sendTextChunked(target, cleaned, {
          msgId: usePassive ? msg.id : undefined,
          eventId: usePassive ? msg.eventId : undefined,
          maxChars: this.cfg.bridge.maxReplyChars,
          startSeq: budget.seq,
          forceProactive: !usePassive,
        });
        budget.seq = r.nextSeq;
        if (r.usedProactive) {
          budget.forceProactive = true;
          budget.passiveLeft = 0;
        } else if (usePassive) {
          budget.passiveLeft = Math.max(0, budget.passiveLeft - r.passiveSent);
          if (budget.passiveLeft === 0) budget.forceProactive = true;
        }
      } catch (err) {
        console.warn(
          `[bridge] reply failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const fp of files) {
      try {
        console.log(`[bridge] SEND_FILE -> ${fp}`);
        const usePassive = !budget.forceProactive && budget.passiveLeft > 0;
        budget.seq = await this.api.sendLocalFile(target, fp, {
          msgId: usePassive ? msg.id : undefined,
          eventId: usePassive ? msg.eventId : undefined,
          msgSeq: budget.seq,
        });
        if (usePassive) {
          budget.passiveLeft = Math.max(0, budget.passiveLeft - 1);
          if (budget.passiveLeft === 0) budget.forceProactive = true;
        }
        await sleep(300);
      } catch (err) {
        console.error(`[bridge] send file failed: ${fp}`, err);
        const errText = `发送文件失败: ${fp}\n${err instanceof Error ? err.message : String(err)}`;
        const r = await this.api.sendTextChunked(
          target,
          errText.slice(0, this.cfg.bridge.maxReplyChars),
          {
            msgId: budget.forceProactive ? undefined : msg.id,
            eventId: budget.forceProactive ? undefined : msg.eventId,
            maxChars: this.cfg.bridge.maxReplyChars,
            startSeq: budget.seq,
            forceProactive: budget.forceProactive,
          },
        );
        budget.seq = r.nextSeq;
        if (r.usedProactive) budget.forceProactive = true;
        else budget.passiveLeft = Math.max(0, budget.passiveLeft - r.passiveSent);
      }
    }

    if (!cleaned && files.length === 0 && opts?.isFinal) {
      const r = await this.api.sendTextChunked(target, "(空回复)", {
        msgId: budget.forceProactive ? undefined : msg.id,
        eventId: budget.forceProactive ? undefined : msg.eventId,
        maxChars: this.cfg.bridge.maxReplyChars,
        startSeq: budget.seq,
        forceProactive: budget.forceProactive,
      });
      budget.seq = r.nextSeq;
    }

    this.nextSeqByMsgId.set(msg.id, budget.seq);
    this.replyBudget.set(msg.id, budget);
    if (this.replyBudget.size > 2000) {
      const first = this.replyBudget.keys().next().value;
      if (first) this.replyBudget.delete(first);
    }
  }

  /**
   * 流式输出：StreamTracker 已保证传入的是稳定的完整助手气泡，收到即发。
   * 被动回复额度耗尽后由 reply()/QQ API 自动切换主动发送，不能再为保护额度牺牲实时性。
   */
  private createStreamCoalescer(
    target: SendTarget,
    msg: IncomingQqMessage,
  ): {
    push: (text: string) => Promise<void>;
    flush: (isFinal?: boolean) => Promise<void>;
  } {
    let chain: Promise<void> = Promise.resolve();

    const doSend = async (text: string, isFinal: boolean) => {
      const t = text.trim();
      if (!t) return;
      await this.reply(target, msg, t, { isFinal });
    };

    return {
      push: (text: string) => {
        // 每个稳定气泡立即投递，恢复原先实时流式体验。
        chain = chain.then(() => doSend(text, false));
        return chain;
      },
      flush: (_isFinal = true) => chain,
    };
  }
}

function toSendTarget(msg: IncomingQqMessage): SendTarget | null {
  if (msg.groupOpenId) return { kind: "group", groupOpenid: msg.groupOpenId };
  if (msg.channelId) return { kind: "channel", channelId: msg.channelId };
  if (msg.event === "C2C_MESSAGE_CREATE" || msg.event === "DIRECT_MESSAGE_CREATE") {
    return { kind: "c2c", openid: msg.authorOpenId };
  }
  if (msg.authorOpenId && !msg.groupOpenId && !msg.channelId) {
    return { kind: "c2c", openid: msg.authorOpenId };
  }
  return null;
}

function buildSessionKey(msg: IncomingQqMessage): string {
  if (msg.groupOpenId) return `group:${msg.groupOpenId}:${msg.authorOpenId}`;
  if (msg.channelId) return `channel:${msg.channelId}:${msg.authorOpenId}`;
  return `c2c:${msg.authorOpenId}`;
}


/** 群里只 @ 机器人 / 私聊空消息唤醒 */
function isMentionOnlyMessage(
  msg: IncomingQqMessage,
  text: string,
  media: { images: unknown[]; files: unknown[] },
): boolean {
  if (text) return false;
  if (media.images.length || media.files.length) return false;
  const raw = String(msg.content || "");
  // 去掉 mention 标记和空白后仍无内容
  const stripped = raw.replace(/<@!?[^>]+>/g, "").replace(/\s+/g, "").trim();
  if (stripped) return false;
  // 群 AT 事件，或正文里带了 @
  if (msg.event === "GROUP_AT_MESSAGE_CREATE" || msg.event === "AT_MESSAGE_CREATE") return true;
  if (/<@!?[^>]+>/.test(raw)) return true;
  // 私聊里发空/纯空白也允许唤醒
  if (msg.event === "C2C_MESSAGE_CREATE" || msg.event === "DIRECT_MESSAGE_CREATE") {
    return raw.trim() === "" || raw.replace(/\s+/g, "") === "";
  }
  return false;
}

function normalizeUserText(content: string, wakePrefix: string): string {
  let text = content.replace(/<@!?[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (wakePrefix) {
    if (!text.startsWith(wakePrefix)) return "";
    text = text.slice(wakePrefix.length).trim();
  }
  return text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 双向原样转发：用户发什么，PiDeck 就收到什么。
 * 仅附件无法纯文本表达时，附加本地路径行。
 */
function buildPrompt(
  text: string,
  media: { images: DownloadedMedia[]; files: DownloadedMedia[] },
): string {
  const hasMedia = media.images.length > 0 || media.files.length > 0;
  if (!hasMedia) return text;

  const parts: string[] = [];
  if (text) parts.push(text);
  for (const img of media.images) parts.push(img.filePath);
  for (const f of media.files) parts.push(f.filePath);
  return parts.join("\n");
}
