#!/usr/bin/env node
/**
 * Enable PiDeck web service in settings.json (requires PiDeck restart).
 * Cross-platform: macOS / Windows / Linux
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function candidatePaths() {
  const home = homedir();
  const list = [];
  if (process.env.PIDEEK_SETTINGS) list.push(process.env.PIDEEK_SETTINGS);
  // macOS
  list.push(join(home, "Library/Application Support/pi-desktop/settings.json"));
  // Windows
  if (process.env.APPDATA) {
    list.push(join(process.env.APPDATA, "pi-desktop", "settings.json"));
  }
  list.push(join(home, "AppData/Roaming/pi-desktop/settings.json"));
  // Linux
  list.push(join(home, ".config/pi-desktop/settings.json"));
  return list;
}

const settingsPath = candidatePaths().find((p) => existsSync(p));
if (!settingsPath) {
  console.error("找不到 PiDeck settings.json，已尝试：");
  for (const p of candidatePaths()) console.error(" -", p);
  console.error("\n可设置环境变量 PIDEEK_SETTINGS=/绝对路径/settings.json");
  process.exit(1);
}

const raw = readFileSync(settingsPath, "utf8");
const settings = JSON.parse(raw);
const before = {
  webServiceEnabled: settings.webServiceEnabled,
  webServiceHost: settings.webServiceHost,
  webServicePort: settings.webServicePort,
};

settings.webServiceEnabled = true;
settings.webServiceHost = settings.webServiceHost || "127.0.0.1";
settings.webServicePort = settings.webServicePort || 8765;

writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
console.log("已更新 PiDeck Web 服务设置:");
console.log("  file :", settingsPath);
console.log("  before:", before);
console.log("  after :", {
  webServiceEnabled: settings.webServiceEnabled,
  webServiceHost: settings.webServiceHost,
  webServicePort: settings.webServicePort,
});
console.log("\n请完全退出并重新打开 PiDeck，然后访问:");
console.log(`  http://127.0.0.1:${settings.webServicePort}/api/health`);
