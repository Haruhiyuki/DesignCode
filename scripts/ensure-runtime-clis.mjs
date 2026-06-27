import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";

const runtimeClis = [
  {
    label: "OpenCode",
    command: "opencode",
    envKey: "OPENCODE_BIN_PATH",
    packageSpec: "opencode-ai@latest"
  },
  {
    label: "Codex",
    command: "codex",
    envKey: "CODEX_BIN_PATH",
    packageSpec: "@openai/codex@latest"
  }
];

function stripOuterQuotes(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function normalizeWindowsCommandPath(commandPath) {
  if (!isWindows || !commandPath) {
    return commandPath;
  }

  const normalized = stripOuterQuotes(commandPath);
  const extension = path.extname(normalized).toLowerCase();
  const candidates = [normalized];

  if (!extension) {
    candidates.push(`${normalized}.exe`, `${normalized}.cmd`, `${normalized}.bat`, `${normalized}.ps1`);
  } else if (extension === ".ps1") {
    candidates.push(
      normalized.slice(0, -extension.length) + ".exe",
      normalized.slice(0, -extension.length) + ".cmd",
      normalized.slice(0, -extension.length) + ".bat"
    );
  } else if (extension === ".cmd" || extension === ".bat") {
    candidates.push(normalized.slice(0, -extension.length) + ".exe");
  }

  return candidates.find((candidate) => existsSync(candidate)) || normalized;
}

function explicitPathExists(envKey) {
  const explicit = stripOuterQuotes(process.env[envKey]);
  if (!explicit) {
    return false;
  }

  return existsSync(normalizeWindowsCommandPath(explicit));
}

function commandExists(command) {
  const lookupCommand = isWindows ? "where.exe" : "which";

  try {
    execFileSync(lookupCommand, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

function npmCommand() {
  return isWindows ? "npm.cmd" : "npm";
}

function main() {
  const missing = runtimeClis.filter((cli) => {
    return !explicitPathExists(cli.envKey) && !commandExists(cli.command);
  });

  if (!missing.length) {
    console.log("OpenCode / Codex CLI 已就绪，跳过安装。");
    return;
  }

  const packageSpecs = missing.map((cli) => cli.packageSpec);
  console.log(`缺少 ${missing.map((cli) => cli.label).join(" / ")} CLI，正在安装：${packageSpecs.join(" ")}`);

  const result = spawnSync(npmCommand(), ["install", "-g", ...packageSpecs], {
    stdio: "inherit",
    shell: false
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  const stillMissing = missing.filter((cli) => {
    return !explicitPathExists(cli.envKey) && !commandExists(cli.command);
  });
  if (stillMissing.length) {
    throw new Error(
      `已安装依赖，但仍无法在 PATH 中找到：${stillMissing.map((cli) => cli.command).join(", ")}`
    );
  }
}

main();
