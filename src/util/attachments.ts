import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface QqAttachment {
  url?: string;
  content_type?: string;
  contentType?: string;
  filename?: string;
  file_name?: string;
  size?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface DownloadedMedia {
  kind: "image" | "file";
  filePath: string;
  fileName: string;
  mimeType: string;
  sourceUrl: string;
  /** only for images */
  data?: string;
}

const IMAGE_MIME_RE = /^image\//i;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_FILES = 6;

export function extractAttachments(raw: unknown): QqAttachment[] {
  if (!raw || typeof raw !== "object") return [];
  const data = raw as Record<string, unknown>;
  const list = data.attachments;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is QqAttachment => !!item && typeof item === "object");
}

export function isImageAttachment(att: QqAttachment): boolean {
  const ct = String(att.content_type || att.contentType || "").toLowerCase();
  if (ct && IMAGE_MIME_RE.test(ct)) return true;
  const name = String(att.filename || att.file_name || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(name)) return true;
  const url = String(att.url || "");
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif)(\?|$)/i.test(url);
}

function guessImageMime(att: QqAttachment, buf: Buffer): string {
  const ct = String(att.content_type || att.contentType || "").split(";")[0].trim();
  if (ct && IMAGE_MIME_RE.test(ct)) return ct;
  const name = String(att.filename || att.file_name || att.url || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".bmp")) return "image/bmp";
  if (name.endsWith(".heic") || name.endsWith(".heif")) return "image/heic";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.slice(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buf.length >= 6 && buf.slice(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/png";
}

function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  if (m.includes("bmp")) return "bmp";
  if (m.includes("heic") || m.includes("heif")) return "heic";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "bin";
}

function safeName(raw: string, fallback: string): string {
  const cleaned = String(raw || "")
    .replace(/[^\w.\-()+@\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

async function downloadOne(
  att: QqAttachment,
  options: { authorization?: string; saveDir: string; kind: "image" | "file" },
): Promise<DownloadedMedia | null> {
  const url = String(att.url || "").trim();
  if (!url) return null;
  const headers: Record<string, string> = {};
  if (options.authorization) headers.Authorization = options.authorization;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.warn(`[qq-media] download failed ${res.status}: ${url.slice(0, 120)}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return null;

  const max = options.kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (buf.length > max) {
    console.warn(`[qq-media] skip oversized ${options.kind} ${buf.length} bytes`);
    return null;
  }

  const mimeType =
    options.kind === "image"
      ? guessImageMime(att, buf)
      : String(att.content_type || att.contentType || "application/octet-stream").split(";")[0] ||
        "application/octet-stream";

  const fallback =
    options.kind === "image"
      ? `qq-img-${Date.now()}.${extForMime(mimeType)}`
      : `qq-file-${Date.now()}.bin`;
  let fileName = safeName(String(att.filename || att.file_name || ""), fallback);
  if (options.kind === "image" && !/\.[a-z0-9]+$/i.test(fileName)) {
    fileName = `${fileName}.${extForMime(mimeType)}`;
  }
  const filePath = join(options.saveDir, `${Date.now()}-${fileName}`);
  writeFileSync(filePath, buf);
  console.log(`[qq-media] saved ${options.kind} ${filePath} (${buf.length} bytes, ${mimeType})`);

  return {
    kind: options.kind,
    filePath,
    fileName,
    mimeType,
    sourceUrl: url,
    ...(options.kind === "image" ? { data: buf.toString("base64") } : {}),
  };
}

export async function downloadQqMedia(
  attachments: QqAttachment[],
  options: {
    authorization?: string;
    saveDir?: string;
  } = {},
): Promise<{ images: DownloadedMedia[]; files: DownloadedMedia[] }> {
  if (!attachments.length) return { images: [], files: [] };
  const saveDir = options.saveDir || join(tmpdir(), "pi-qq-media");
  mkdirSync(saveDir, { recursive: true });

  const images: DownloadedMedia[] = [];
  const files: DownloadedMedia[] = [];

  for (const att of attachments) {
    try {
      if (isImageAttachment(att)) {
        if (images.length >= MAX_IMAGES) continue;
        const item = await downloadOne(att, {
          authorization: options.authorization,
          saveDir,
          kind: "image",
        });
        if (item) images.push(item);
      } else if (att.url) {
        if (files.length >= MAX_FILES) continue;
        const item = await downloadOne(att, {
          authorization: options.authorization,
          saveDir,
          kind: "file",
        });
        if (item) files.push(item);
      }
    } catch (err) {
      console.warn(
        `[qq-media] download error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { images, files };
}

export function toPromptImages(images: DownloadedMedia[]): PromptImage[] {
  return images
    .filter((img) => img.kind === "image" && img.data)
    .map((img) => ({
      type: "image" as const,
      data: img.data!,
      mimeType: img.mimeType,
    }));
}

/** QQ file_type: 1 image, 2 video, 3 voice, 4 file */
export function qqFileTypeForPath(filePath: string): number {
  const lower = filePath.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(lower)) return 1;
  if (/\.(mp4|mov|m4v)$/i.test(lower)) return 2;
  if (/\.(silk|wav|mp3|amr)$/i.test(lower)) return 3;
  return 4;
}
