import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const currentPath = process.env[pathKey] ?? "";
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const cargoBin = home ? join(home, ".cargo", "bin") : "";

if (cargoBin && existsSync(cargoBin)) {
  const pathEntries = currentPath.split(delimiter).map((entry) => entry.toLowerCase());
  if (!pathEntries.includes(cargoBin.toLowerCase())) {
    process.env[pathKey] = `${cargoBin}${delimiter}${currentPath}`;
  }
}

const tauriCli = join(process.cwd(), "node_modules", "@tauri-apps", "cli", "tauri.js");

if (!existsSync(tauriCli)) {
  console.error("Failed to find local @tauri-apps/cli. Run npm install first.");
  process.exit(1);
}

const child = spawn(process.execPath, [tauriCli, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Failed to start Tauri CLI: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
