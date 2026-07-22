import WebSocket from "ws";
import { QqAccessToken } from "./token.js";
import { QqApi } from "./api.js";
import { extractAttachments, type QqAttachment } from "../util/attachments.js";

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export interface IncomingQqMessage {
  event: string;
  eventId?: string;
  id: string;
  content: string;
  timestamp?: string;
  authorOpenId: string;
  authorUsername?: string;
  groupOpenId?: string;
  channelId?: string;
  guildId?: string;
  attachments: QqAttachment[];
  raw: unknown;
}

export type MessageHandler = (msg: IncomingQqMessage) => void | Promise<void>;

export class QqGateway {
  private ws: WebSocket | null = null;
  private sessionId = "";
  private lastSeq = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private identifyIntent: number;
  private onMessage: MessageHandler;

  constructor(
    private readonly token: QqAccessToken,
    private readonly api: QqApi,
    intents: number,
    onMessage: MessageHandler,
  ) {
    this.identifyIntent = intents;
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    const url = await this.api.getGatewayUrl();
    console.log(`[qq] connecting gateway: ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      console.log("[qq] websocket open");
    });

    ws.on("message", (data) => {
      void this.handleRaw(String(data));
    });

    ws.on("close", (code, reason) => {
      console.warn(`[qq] websocket closed code=${code} reason=${reason.toString()}`);
      this.clearHeartbeat();
      if (code === 4004) this.token.invalidate();
      if ([9001, 9005].includes(code)) {
        this.sessionId = "";
        this.lastSeq = 0;
      }
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error("[qq] websocket error:", err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((err) => {
        console.error("[qq] reconnect failed:", err);
        this.scheduleReconnect();
      });
    }, 3000);
  }

  private async handleRaw(raw: string): Promise<void> {
    let msg: { op: number; s?: number; t?: string; d?: any; id?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn("[qq] non-json frame");
      return;
    }

    if (typeof msg.s === "number" && msg.s > 0) this.lastSeq = msg.s;

    switch (msg.op) {
      case OP.HELLO:
        await this.onHello();
        return;
      case OP.HEARTBEAT_ACK:
        return;
      case OP.RECONNECT:
        console.log("[qq] server requested reconnect");
        this.ws?.close();
        return;
      case OP.INVALID_SESSION:
        console.warn("[qq] invalid session, full re-identify next time");
        this.sessionId = "";
        this.lastSeq = 0;
        this.ws?.close();
        return;
      case OP.DISPATCH:
        await this.onDispatch(msg.t || "", msg.d, msg.id);
        return;
      default:
        return;
    }
  }

  private async onHello(): Promise<void> {
    if (this.sessionId) {
      await this.resume();
    } else {
      await this.identify();
    }
  }

  private async identify(): Promise<void> {
    const authorization = await this.token.getAuthorization();
    console.log("[qq] identify...");
    this.send({
      op: OP.IDENTIFY,
      d: {
        token: authorization,
        intents: this.identifyIntent,
        shard: [0, 1],
      },
    });
  }

  private async resume(): Promise<void> {
    const authorization = await this.token.getAuthorization();
    console.log("[qq] resume...");
    this.send({
      op: OP.RESUME,
      d: {
        token: authorization,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    });
  }

  private startHeartbeat(intervalMs = 30000): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: OP.HEARTBEAT, d: this.lastSeq || null });
    }, intervalMs);
    // send one immediately
    this.send({ op: OP.HEARTBEAT, d: this.lastSeq || null });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private async onDispatch(event: string, data: any, eventId?: string): Promise<void> {
    if (event === "READY") {
      this.sessionId = data?.session_id || "";
      const name = data?.user?.username || "bot";
      console.log(`[qq] READY as 「${name}」 session=${this.sessionId}`);
      this.startHeartbeat(30_000);
      return;
    }
    if (event === "RESUMED") {
      console.log("[qq] RESUMED");
      this.startHeartbeat(30_000);
      return;
    }

    const incoming = parseDispatchMessage(event, data, eventId);
    if (!incoming) return;

    try {
      await this.onMessage(incoming);
    } catch (err) {
      console.error(`[qq] handler error on ${event}:`, err);
    }
  }
}

function parseDispatchMessage(
  event: string,
  data: any,
  eventId?: string,
): IncomingQqMessage | null {
  if (!data || typeof data !== "object") return null;

  const content = typeof data.content === "string" ? data.content : "";
  const id = String(data.id || "");
  if (!id) return null;
  const attachments = extractAttachments(data);

  switch (event) {
    case "C2C_MESSAGE_CREATE": {
      const authorOpenId = String(data.author?.user_openid || data.author?.id || "");
      if (!authorOpenId) return null;
      return {
        event,
        eventId,
        id,
        content,
        timestamp: data.timestamp,
        authorOpenId,
        authorUsername: data.author?.username,
        attachments,
        raw: data,
      };
    }
    case "GROUP_AT_MESSAGE_CREATE":
    case "GROUP_MESSAGE_CREATE": {
      const authorOpenId = String(
        data.author?.member_openid || data.author?.id || data.author?.user_openid || "",
      );
      const groupOpenId = String(data.group_openid || "");
      if (!authorOpenId || !groupOpenId) return null;
      return {
        event,
        eventId,
        id,
        content,
        timestamp: data.timestamp,
        authorOpenId,
        authorUsername: data.author?.username,
        groupOpenId,
        attachments,
        raw: data,
      };
    }
    case "AT_MESSAGE_CREATE":
    case "MESSAGE_CREATE": {
      const authorOpenId = String(data.author?.id || "");
      const channelId = String(data.channel_id || "");
      if (!authorOpenId || !channelId) return null;
      return {
        event,
        eventId,
        id,
        content,
        timestamp: data.timestamp,
        authorOpenId,
        authorUsername: data.author?.username,
        channelId,
        guildId: data.guild_id ? String(data.guild_id) : undefined,
        attachments,
        raw: data,
      };
    }
    case "DIRECT_MESSAGE_CREATE": {
      const authorOpenId = String(data.author?.id || "");
      if (!authorOpenId) return null;
      return {
        event,
        eventId,
        id,
        content,
        timestamp: data.timestamp,
        authorOpenId,
        authorUsername: data.author?.username,
        guildId: data.guild_id ? String(data.guild_id) : undefined,
        attachments,
        raw: data,
      };
    }
    default:
      return null;
  }
}
