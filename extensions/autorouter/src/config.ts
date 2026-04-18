import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { AutorouterConfig } from "./types";

export function loadConfig(cwd: string): AutorouterConfig | null {
  const projectPath = join(cwd, ".pi", "autorouter.json");
  const globalPath = join(getAgentDir(), "autorouter.json");

  let config: Partial<AutorouterConfig> = {};
  let loaded = false;

  if (existsSync(globalPath)) {
    try {
      config = JSON.parse(readFileSync(globalPath, "utf-8"));
      loaded = true;
    } catch {
      // ignore
    }
  }

  if (existsSync(projectPath)) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(projectPath, "utf-8")) };
      loaded = true;
    } catch {
      // ignore
    }
  }

  if (!loaded) return null;
  return config as AutorouterConfig;
}
