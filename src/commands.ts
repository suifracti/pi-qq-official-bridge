import type { PiDeckClient, PiDeckModelInfo, PiDeckRuntimeState } from "./pideck/client.js";

export type ParsedCommand =
  | { type: "help" }
  | { type: "new" }
  | { type: "status" }
  | { type: "stop" }
  | { type: "dialogs"; action: "list" | "select" | "current"; query?: string }
  | { type: "stream"; action: "show" | "set"; key?: "thinking" | "tools" | "text"; value?: boolean }
  | { type: "model"; action: "show" | "cycle" | "set"; query?: string }
  | { type: "think"; action: "show" | "cycle" | "set"; level?: string }
  | { type: "plan"; action: "toggle" | "on" | "off" | "status" };

const THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const THINK_ALIASES: Record<string, string> = {
  off: "off",
  "0": "off",
  关: "off",
  关闭: "off",
  无: "off",
  none: "off",
  minimal: "minimal",
  min: "minimal",
  极低: "minimal",
  最低: "minimal",
  low: "low",
  低: "low",
  medium: "medium",
  mid: "medium",
  med: "medium",
  中: "medium",
  中等: "medium",
  high: "high",
  高: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  很高: "xhigh",
  超高: "xhigh",
  max: "max",
  maximum: "max",
  最大: "max",
  满: "max",
};

const THINK_LABEL: Record<string, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最大",
};

/**
 * Parse QQ control commands (Chinese + English).
 * Returns null if the text is a normal chat message.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const raw = text.trim();
  if (!raw) return null;

  // strip leading / or fullwidth ／
  const body = raw.replace(/^[/／]\s*/, "").trim();
  if (!body) return null;

  // Only treat as command if original started with / or matches bare Chinese keywords
  const hasSlash = /^[/／]/.test(raw);
  const parts = body.split(/\s+/);
  const head = (parts[0] || "").toLowerCase();
  const arg = parts.slice(1).join(" ").trim();
  const headCn = parts[0] || "";

  // help
  if (
    matchesHead(head, headCn, ["help", "h", "帮助", "说明", "菜单", "指令"]) ||
    (!hasSlash && ["帮助", "说明", "菜单"].includes(headCn))
  ) {
    return { type: "help" };
  }

  // new session
  if (
    matchesHead(head, headCn, ["new", "reset", "新会话", "新对话", "重置", "新建"]) ||
    (!hasSlash && ["新会话", "新对话", "重置"].includes(headCn))
  ) {
    return { type: "new" };
  }

  // dialogs list / select
  if (
    matchesHead(head, headCn, [
      "dialog",
      "dialogs",
      "chat",
      "chats",
      "session",
      "sessions",
      "对话框",
      "对话",
      "会话",
      "窗口",
      "切换",
      "选择",
    ]) ||
    (!hasSlash && ["对话框", "会话列表", "切换对话"].includes(headCn))
  ) {
    const q = arg.trim();
    if (!q || q === "list" || q === "列表" || q === "ls") {
      return { type: "dialogs", action: "list" };
    }
    if (q === "current" || q === "当前" || q === "cur" || q === "now") {
      return { type: "dialogs", action: "current" };
    }
    return { type: "dialogs", action: "select", query: q };
  }

  // status
  if (
    matchesHead(head, headCn, ["status", "状态", "当前", "info", "信息"]) ||
    (!hasSlash && ["状态", "当前状态"].includes(headCn))
  ) {
    return { type: "status" };
  }

  // stop
  if (
    matchesHead(head, headCn, ["stop", "abort", "停止", "中止", "取消"]) ||
    (!hasSlash && ["停止", "中止"].includes(headCn))
  ) {
    return { type: "stop" };
  }

  // stream output toggles
  if (
    matchesHead(head, headCn, ["stream", "output", "输出", "流式"]) ||
    (!hasSlash && ["输出", "流式"].includes(headCn))
  ) {
    if (!arg) return { type: "stream", action: "show" };
    const parts = arg.split(/\s+/);
    const kraw = (parts[0] || "").toLowerCase();
    const vraw = (parts[1] || "").toLowerCase();
    let key: "thinking" | "tools" | "text" | undefined;
    if (["thinking", "think", "思考", "思维"].includes(kraw)) key = "thinking";
    else if (["bash", "tool", "tools", "命令", "工具", "shell"].includes(kraw)) key = "tools";
    else if (["text", "正文", "回复", "body"].includes(kraw)) key = "text";
    if (!key) return { type: "stream", action: "show" };
    const on = ["on", "1", "true", "开", "开启", "打开", "是"].includes(vraw);
    const off = ["off", "0", "false", "关", "关闭", "否"].includes(vraw);
    if (!on && !off) return { type: "stream", action: "show" };
    return { type: "stream", action: "set", key, value: on };
  }

  // model
  if (matchesHead(head, headCn, ["model", "models", "模型", "切换模型"])) {
    if (!arg) return { type: "model", action: "show" };
    if (isCycleWord(arg)) return { type: "model", action: "cycle" };
    return { type: "model", action: "set", query: arg };
  }
  if (!hasSlash && headCn === "模型") {
    if (!arg) return { type: "model", action: "show" };
    if (isCycleWord(arg)) return { type: "model", action: "cycle" };
    return { type: "model", action: "set", query: arg };
  }

  // thinking
  if (
    matchesHead(head, headCn, [
      "think",
      "thinking",
      "思考",
      "思考强度",
      "思维",
      "推理",
    ])
  ) {
    if (!arg) return { type: "think", action: "show" };
    if (isCycleWord(arg)) return { type: "think", action: "cycle" };
    const level = normalizeThinkLevel(arg);
    if (!level) {
      return { type: "think", action: "show" };
    }
    return { type: "think", action: "set", level };
  }

  // plan mode
  if (
    matchesHead(head, headCn, [
      "plan",
      "计划",
      "计划模式",
      "规划",
      "规划模式",
    ])
  ) {
    if (!arg || ["切换", "toggle"].includes(arg.toLowerCase())) {
      return { type: "plan", action: "toggle" };
    }
    if (["on", "enable", "开", "开启", "启用", "打开"].includes(arg.toLowerCase()) || arg === "开") {
      return { type: "plan", action: "on" };
    }
    if (
      ["off", "disable", "关", "关闭", "禁用", "普通", "normal"].includes(arg.toLowerCase()) ||
      arg === "关"
    ) {
      return { type: "plan", action: "off" };
    }
    if (["状态", "status"].includes(arg.toLowerCase())) {
      return { type: "plan", action: "status" };
    }
    return { type: "plan", action: "toggle" };
  }

  // bare Chinese mode switches
  if (!hasSlash) {
    if (["计划模式", "规划模式"].includes(raw)) return { type: "plan", action: "on" };
    if (["普通模式", "退出计划", "退出计划模式"].includes(raw)) return { type: "plan", action: "off" };
  } else {
    if (["普通模式", "普通", "normal"].includes(body.toLowerCase()) || body === "普通模式") {
      return { type: "plan", action: "off" };
    }
    if (["计划模式", "规划模式"].includes(body)) return { type: "plan", action: "on" };
  }

  // require slash for unknown short tokens to avoid eating normal chat
  if (!hasSlash) return null;
  return null;
}

export function helpCommandText(backend: string): string {
  return [
    "QQ ↔ PiDeck 控制指令（中英均可）",
    "",
    "【会话】",
    "/帮助 · 帮助",
    "/状态 · 状态",
    "/对话框 · 列出 PiDeck 对话框",
    "/对话框 1 · 切换到列表第 1 个",
    "/对话框 当前 · 查看当前绑定",
    "/新会话 · 新对话 · /new",
    "/停止 · /stop",
    "",
    "【模型】",
    "/模型 · 查看当前与可用模型",
    "/模型 关键词 · 切换模型（模糊匹配）",
    "/模型 下一个 · 循环切换",
    "",
    "【思考强度】",
    "/思考 · 查看当前强度",
    "/思考 关|低|中|高|很高|最大",
    "/思考 切换",
    "英文: off minimal low medium high xhigh max",
    "",
    "【模式】",
    "/计划模式 · 开启只读规划",
    "/普通模式 · 恢复可写普通模式",
    "/计划 · 切换计划模式",
    "",
    `当前后端: ${backend === "pideck" ? "PiDeck 对话框" : "独立 SDK"}`,
    "说明: 模型/思考改的是当前 QQ 会话对应的 PiDeck 对话框；也可在桌面直接改。",
    "附件: 支持 QQ 图片/文件收发；Agent 回文件时写 [SEND_FILE:路径]。",
    "回复: 原样转发 PiDeck 对话框最终回答（自动去掉 thinking）。",
  ].join("\n");
}

export async function runPideckCommand(
  client: PiDeckClient,
  agentId: string,
  cmd: ParsedCommand,
): Promise<string> {
  switch (cmd.type) {
    case "help":
      return helpCommandText("pideck");
    case "status":
      return formatStatus(await client.getRuntime(agentId), agentId);
    case "stop":
      await client.stopAgent(agentId);
      return "已请求停止当前响应。";
    case "model":
      return handleModel(client, agentId, cmd);
    case "think":
      return handleThink(client, agentId, cmd);
    case "plan":
      return handlePlan(client, agentId, cmd);
    case "new":
      return "请使用会话层 /新会话 处理。";
    case "dialogs":
      return "请使用会话层 /对话框 处理。";
    case "stream":
      return "请使用会话层 /输出 处理。";
    default:
      return "未知指令";
  }
}

async function handleModel(
  client: PiDeckClient,
  agentId: string,
  cmd: Extract<ParsedCommand, { type: "model" }>,
): Promise<string> {
  if (cmd.action === "cycle") {
    const state = await client.cycleModel(agentId);
    return `已切换到下一个模型\n${formatRuntimeBrief(state)}`;
  }
  if (cmd.action === "set" && cmd.query) {
    const models = await client.listModels(agentId);
    const hit = matchModel(models, cmd.query);
    if (!hit) {
      return [
        `未找到匹配模型: ${cmd.query}`,
        "",
        "可用模型（最多 30 个）:",
        ...formatModelList(models).slice(0, 30),
        "",
        "用法: /模型 关键词",
      ].join("\n");
    }
    const provider = String(hit.provider || "");
    const modelId = String(hit.id || hit.modelId || "");
    if (!provider || !modelId) {
      return `模型数据不完整: ${JSON.stringify(hit)}`;
    }
    const state = await client.setModel(agentId, provider, modelId);
    return `已切换模型\n${formatRuntimeBrief(state)}`;
  }

  // show
  const [runtime, models] = await Promise.all([
    client.getRuntime(agentId),
    client.listModels(agentId),
  ]);
  return [
    "当前模型",
    formatRuntimeBrief(runtime),
    "",
    `可用模型 (${models.length}):`,
    ...formatModelList(models).slice(0, 40),
    models.length > 40 ? `… 还有 ${models.length - 40} 个，可用 /模型 关键词 筛选` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function handleThink(
  client: PiDeckClient,
  agentId: string,
  cmd: Extract<ParsedCommand, { type: "think" }>,
): Promise<string> {
  if (cmd.action === "cycle") {
    const state = await client.cycleThinking(agentId);
    return `已切换思考强度\n${formatRuntimeBrief(state)}`;
  }
  if (cmd.action === "set" && cmd.level) {
    const state = await client.setThinking(agentId, cmd.level);
    return `已设置思考强度为 ${labelThink(cmd.level)}\n${formatRuntimeBrief(state)}`;
  }
  const state = await client.getRuntime(agentId);
  return [
    "当前思考强度",
    formatRuntimeBrief(state),
    "",
    "可选: 关 / 极低 / 低 / 中 / 高 / 很高 / 最大",
    "英文: off minimal low medium high xhigh max",
    "用法: /思考 高   或   /思考 切换",
  ].join("\n");
}

async function handlePlan(
  client: PiDeckClient,
  agentId: string,
  cmd: Extract<ParsedCommand, { type: "plan" }>,
): Promise<string> {
  if (cmd.action === "on") {
    await client.sendCommand(agentId, "/plan on");
    return "已开启【计划模式】（只读规划，不直接改文件）。\n桌面状态栏可确认；发 /普通模式 可退出。";
  }
  if (cmd.action === "off") {
    await client.sendCommand(agentId, "/plan off");
    return "已切换为【普通模式】（可写文件/执行修改）。";
  }
  if (cmd.action === "status") {
    return [
      "计划模式说明:",
      "- 计划模式: 只读分析，先出 Plan",
      "- 普通模式: 可编辑/执行",
      "指令: /计划模式  开启",
      "      /普通模式  关闭",
      "      /计划      切换",
      "（具体是否开启请看 PiDeck 对话框状态）",
    ].join("\n");
  }
  await client.sendCommand(agentId, "/plan");
  return "已发送计划模式切换指令。\n开启: /计划模式\n关闭: /普通模式";
}

function formatStatus(state: PiDeckRuntimeState, agentId: string): string {
  return [
    "当前会话状态",
    `Agent: ${agentId.slice(0, 8)}…`,
    formatRuntimeBrief(state),
    state.isStreaming || state.isExecutingTool
      ? `运行中${state.executingToolName ? ` · 工具 ${state.executingToolName}` : ""}`
      : "空闲",
    state.contextPercent != null
      ? `上下文: ${Math.round(state.contextPercent)}%` +
        (state.contextTokens != null && state.contextWindow != null
          ? ` (${state.contextTokens}/${state.contextWindow})`
          : "")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatRuntimeBrief(state: PiDeckRuntimeState): string {
  const model =
    state.modelName ||
    (state.provider && state.modelId ? `${state.provider}/${state.modelId}` : state.modelId) ||
    "未知模型";
  const think = state.thinkingLevel ? labelThink(state.thinkingLevel) : "未知";
  return `模型: ${model}\n思考: ${think}${state.thinkingLevel ? ` (${state.thinkingLevel})` : ""}`;
}

function formatModelList(models: PiDeckModelInfo[]): string[] {
  return models.map((m, i) => {
    const provider = String(m.provider || "?");
    const id = String(m.id || m.modelId || "?");
    const name = m.name && String(m.name) !== id ? ` · ${m.name}` : "";
    return `${i + 1}. ${provider}/${id}${name}`;
  });
}

function matchModel(models: PiDeckModelInfo[], query: string): PiDeckModelInfo | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  // provider/id exact
  const slash = q.split("/");
  if (slash.length === 2) {
    const [p, id] = slash;
    const exact = models.find(
      (m) =>
        String(m.provider || "").toLowerCase() === p &&
        String(m.id || m.modelId || "").toLowerCase() === id,
    );
    if (exact) return exact;
  }

  const scored = models
    .map((m) => {
      const provider = String(m.provider || "").toLowerCase();
      const id = String(m.id || m.modelId || "").toLowerCase();
      const name = String(m.name || "").toLowerCase();
      const full = `${provider}/${id}`;
      let score = 0;
      if (full === q || id === q) score = 100;
      else if (full.startsWith(q) || id.startsWith(q)) score = 80;
      else if (id.includes(q) || full.includes(q) || name.includes(q)) score = 50;
      else if (provider.includes(q)) score = 20;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.m ?? null;
}

function normalizeThinkLevel(input: string): string | null {
  const key = input.trim().toLowerCase();
  if (THINK_ALIASES[key]) return THINK_ALIASES[key];
  if (THINK_ALIASES[input.trim()]) return THINK_ALIASES[input.trim()];
  if ((THINK_LEVELS as readonly string[]).includes(key)) return key;
  return null;
}

function labelThink(level: string): string {
  return THINK_LABEL[level] || level;
}

function matchesHead(head: string, headCn: string, keys: string[]): boolean {
  const set = new Set(keys.map((k) => k.toLowerCase()));
  return set.has(head) || set.has(headCn.toLowerCase()) || keys.includes(headCn);
}

function isCycleWord(arg: string): boolean {
  const a = arg.trim().toLowerCase();
  return ["下一个", "切换", "循环", "next", "cycle", "toggle", "+"].includes(a);
}

export { THINK_LEVELS, labelThink };
