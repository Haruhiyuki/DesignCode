// Windows 构建后运行：对 NSIS 安装包签名并生成 latest.json。
//
// Tauri v2 的 --bundles 不再支持 updater 目标，需要手动完成：
//   1. 用 TAURI_SIGNING_PRIVATE_KEY 对 .exe 签名 → .exe.sig
//   2. 生成 latest.json（包含 windows-x86_64 平台条目）

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 读取配置
// ---------------------------------------------------------------------------

const tauriConf = JSON.parse(readFileSync(path.join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"));
const productName = tauriConf.productName || "DesignCode";
const version = tauriConf.version || "0.0.0";

const tauriPrivateKey = (process.env.TAURI_SIGNING_PRIVATE_KEY || "").trim();
const tauriPrivateKeyPassword = (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || "").trim();

// ---------------------------------------------------------------------------
// 定位 NSIS 安装包
// ---------------------------------------------------------------------------

const nsisDir = path.join(rootDir, "src-tauri", "target", "release", "bundle", "nsis");
if (!existsSync(nsisDir)) {
  console.error("NSIS bundle directory not found:", nsisDir);
  process.exit(1);
}

const exeName = `${productName}_${version}_x64-setup.exe`;
const exePath = path.join(nsisDir, exeName);
if (!existsSync(exePath)) {
  // 尝试查找任何匹配的 exe
  const found = readdirSync(nsisDir).find((f) => f.endsWith("-setup.exe"));
  if (!found) {
    console.error("NSIS installer not found:", exePath);
    process.exit(1);
  }
  console.warn(`Expected ${exeName}, found ${found}`);
}

const installerPath = existsSync(exePath)
  ? exePath
  : path.join(nsisDir, readdirSync(nsisDir).find((f) => f.endsWith("-setup.exe")));
const installerName = path.basename(installerPath);

console.log(`Installer: ${installerPath}`);

// ---------------------------------------------------------------------------
// 签名
// ---------------------------------------------------------------------------

const sigPath = `${installerPath}.sig`;

if (tauriPrivateKey) {
  console.log("Signing installer with TAURI_SIGNING_PRIVATE_KEY...");

  const tauriBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");

  const signResult = spawnSync(tauriBin, ["signer", "sign", installerPath], {
    encoding: "utf8",
    shell: true,
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: tauriPrivateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: tauriPrivateKeyPassword || ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (signResult.status !== 0) {
    console.error("Signer failed:", (signResult.stderr || "").trim());
  }

  // tauri signer 会自动创建 .sig 文件，或输出签名到 stdout
  if (!existsSync(sigPath) && signResult.stdout?.trim()) {
    writeFileSync(sigPath, signResult.stdout.trim());
  }

  if (existsSync(sigPath)) {
    console.log(`Signature: ${sigPath}`);
  } else {
    console.error("ERROR: signature file not created. Updater will not work!");
    console.error("  stdout:", (signResult.stdout || "").slice(0, 200));
    console.error("  stderr:", (signResult.stderr || "").slice(0, 200));
    process.exit(1);
  }
} else {
  console.warn("TAURI_SIGNING_PRIVATE_KEY not set, skipping signature.");
}

// ---------------------------------------------------------------------------
// 生成 latest.json
// ---------------------------------------------------------------------------

let signature = "";
try {
  signature = existsSync(sigPath) ? readFileSync(sigPath, "utf8").trim() : "";
} catch {}

const updaterEndpoints = tauriConf.plugins?.updater?.endpoints || [];
let releaseBaseUrl = `https://github.com/haruhiyuki/DesignCode/releases/download/v${version}`;
for (const endpoint of updaterEndpoints) {
  const match = endpoint.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\//);
  if (match) {
    releaseBaseUrl = `${match[1]}/releases/download/v${version}`;
    break;
  }
}

const latestJson = {
  version,
  notes: `${productName} v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${releaseBaseUrl}/${installerName}`
    }
  }
};

// 直接写到 nsis/ —— 和 installer、.sig 同目录，方便 CI 一次性收集
const latestPath = path.join(nsisDir, "latest.json");
writeFileSync(latestPath, JSON.stringify(latestJson, null, 2) + "\n");
console.log(`latest.json: ${latestPath}`);

// ---------------------------------------------------------------------------
// 完成
// ---------------------------------------------------------------------------

console.log(`
=== Windows build complete ===
  Installer : ${installerPath}${existsSync(sigPath) ? `\n  Signature : ${sigPath}` : ""}
  latest.json: ${latestPath}

Upload to GitHub Release:
  - ${installerName}
  - latest.json
`);
