/**
 * Strip model/PiDeck internal blocks that should not be sent to QQ users.
 * PiDeck embeds thinking into assistant text as <thinking>...</thinking>.
 */

const SEND_FILE_RE = /\[SEND_FILE:([^\]]+)\]/gi;

export function extractSendFiles(text: string): { cleanText: string; files: string[] } {
  const files: string[] = [];
  const cleanText = String(text ?? "")
    .replace(SEND_FILE_RE, (_m, p1: string) => {
      const fp = String(p1 || "").trim().replace(/^["']|["']$/g, "");
      if (fp) files.push(fp);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanText, files: [...new Set(files)] };
}

export function sanitizeReplyForQq(text: string): string {
  let out = String(text ?? "");

  // Closed thinking / think blocks
  out = out.replace(/<\s*thinking\b[^>]*>[\s\S]*?<\s*\/\s*thinking\s*>/gi, "");
  out = out.replace(/<\s*think\b[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, "");
  out = out.replace(/<\s*reason(?:ing)?\b[^>]*>[\s\S]*?<\s*\/\s*reason(?:ing)?\s*>/gi, "");

  // Unclosed trailing blocks
  out = out.replace(/<\s*thinking\b[^>]*>[\s\S]*$/gi, "");
  out = out.replace(/<\s*think\b[^>]*>[\s\S]*$/gi, "");
  out = out.replace(/<\s*reason(?:ing)?\b[^>]*>[\s\S]*$/gi, "");

  // Orphan closing tags
  out = out.replace(/<\s*\/\s*thinking\s*>/gi, "");
  out = out.replace(/<\s*\/\s*think\s*>/gi, "");
  out = out.replace(/<\s*\/\s*reason(?:ing)?\s*>/gi, "");

  // Strip SEND_FILE markers from user-visible text (handled separately)
  out = out.replace(SEND_FILE_RE, "");

  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
