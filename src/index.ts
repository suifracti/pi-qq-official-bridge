import { loadConfig } from "./config.js";
import { PiQqBridge } from "./bridge.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const bridge = new PiQqBridge(cfg);

  const shutdown = async (signal: string) => {
    console.log(`[bridge] received ${signal}, shutting down...`);
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await bridge.start();
  console.log("[bridge] running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[bridge] fatal:", err);
  process.exit(1);
});
