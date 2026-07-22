import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root: qq-official-bridge/ */
export function packageRoot(): string {
  // .pi/extensions/qq/paths.ts -> ../../..
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../..");
}

export function qqAgentDir(): string {
  const dir = join(homedir(), ".pi", "agent", "qq");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const PATHS = {
  get root() {
    return packageRoot();
  },
  get config() {
    return join(packageRoot(), "config.json");
  },
  get configExample() {
    return join(packageRoot(), "config.example.json");
  },
  get pidFile() {
    return join(qqAgentDir(), "daemon.pid");
  },
  get logFile() {
    return join(qqAgentDir(), "daemon.log");
  },
  get stateFile() {
    return join(qqAgentDir(), "state.json");
  },
  get lockFile() {
    return join(qqAgentDir(), "daemon.lock");
  },
};

export function hasConfig(): boolean {
  return existsSync(PATHS.config);
}
