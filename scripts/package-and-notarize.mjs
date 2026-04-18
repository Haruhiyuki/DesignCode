// fix-bundle-signatures.mjs 之后运行。
// 从已补签的 .app 创建分发产物：公证、DMG、updater 包。
//
// 流程:
//   1. 公证 .app + staple
//   2. 创建 DMG → 签名 → 公证 → staple
//   3. 创建 updater .tar.gz → 用 TAURI_SIGNING_PRIVATE_KEY 签名
//   4. 生成 latest.json（上传到 GitHub Releases 供自动更新使用）

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

const appleId = (process.env.APPLE_ID || "").trim();
const applePassword = (process.env.APPLE_PASSWORD || "").trim();
const appleTeamId = (process.env.APPLE_TEAM_ID || "").trim();
const signingIdentity = (process.env.APPLE_SIGNING_IDENTITY || "").trim();
const tauriPrivateKey = (process.env.TAURI_SIGNING_PRIVATE_KEY || "").trim();
const tauriPrivateKeyPassword = (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || "").trim();

const canNotarize = Boolean(appleId && applePassword && appleTeamId);
const canSign = Boolean(signingIdentity);

const archMap = { x64: "x86_64", arm64: "aarch64" };
const tauriArch = archMap[os.arch()] || os.arch();
const tauriTarget = `darwin-${tauriArch}`;

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

// `tauri build --target X` 把 bundle 写到 target/{target}/release/...；无 --target 时在 target/release/...
function resolveTargetReleaseDir() {
  const candidates = [path.join(rootDir, "src-tauri", "target", "release")];
  const targetRoot = path.join(rootDir, "src-tauri", "target");
  try {
    for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "release" || entry.name === "debug") continue;
      candidates.push(path.join(targetRoot, entry.name, "release"));
    }
  } catch {}
  return candidates.find((candidate) => existsSync(path.join(candidate, "bundle", "macos")));
}

const targetReleaseDir = resolveTargetReleaseDir();
if (!targetReleaseDir) {
  console.error("Bundle directory not found under src-tauri/target/**/release/bundle/macos");
  process.exit(1);
}
const bundleBase = path.join(targetReleaseDir, "bundle", "macos");
const outputDir = path.join(targetReleaseDir, "bundle", "dist");
console.log(`Bundle base: ${path.relative(rootDir, bundleBase)}`);

const appBundles = readdirSync(bundleBase)
  .filter((name) => name.endsWith(".app"))
  .map((name) => path.join(bundleBase, name));

if (!appBundles.length) {
  console.error("No .app bundles found in", bundleBase);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
const appPath = appBundles[0];
const appName = path.basename(appPath, ".app");

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function run(cmd, args, options = {}) {
  console.log(`  $ ${cmd} ${args.join(" ").slice(0, 120)}`);
  execFileSync(cmd, args, { stdio: "inherit", timeout: 600_000, ...options });
}

// ---------------------------------------------------------------------------
// 1. 公证 .app
// ---------------------------------------------------------------------------

if (canNotarize) {
  console.log("\n=== Step 1: Notarize .app ===");
  // notarytool 要求 zip/dmg/pkg，不接受 .app 目录
  const notarizeZip = path.join(outputDir, `${appName}-notarize.zip`);
  run("ditto", ["-c", "-k", "--keepParent", appPath, notarizeZip]);
  run("xcrun", [
    "notarytool", "submit", notarizeZip,
    "--apple-id", appleId,
    "--password", applePassword,
    "--team-id", appleTeamId,
    "--wait"
  ]);
  // 删除临时 zip
  try { execFileSync("rm", ["-f", notarizeZip]); } catch {}
  console.log("Notarization succeeded.");

  try {
    run("xcrun", ["stapler", "staple", appPath]);
  } catch {
    console.warn("Staple failed (non-fatal, Gatekeeper can check online).");
  }
} else {
  console.log("\n=== Step 1: Skip notarization (APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID not all set) ===");
}

// ---------------------------------------------------------------------------
// 2. 创建 DMG
// ---------------------------------------------------------------------------

console.log("\n=== Step 2: Create DMG ===");
const dmgName = `${productName}_${version}_${tauriArch}.dmg`;
const dmgPath = path.join(outputDir, dmgName);

// 创建临时目录，放入 .app + Applications 快捷方式
const dmgStaging = path.join(outputDir, ".dmg-staging");
execFileSync("rm", ["-rf", dmgStaging]);
execFileSync("mkdir", ["-p", dmgStaging]);
execFileSync("cp", ["-R", appPath, dmgStaging]);
execFileSync("ln", ["-s", "/Applications", path.join(dmgStaging, "Applications")]);

run("hdiutil", [
  "create",
  "-volname", productName,
  "-srcfolder", dmgStaging,
  "-ov",
  "-format", "UDZO",
  dmgPath
]);

execFileSync("rm", ["-rf", dmgStaging]);

if (canSign) {
  run("codesign", ["--force", "--timestamp", "--sign", signingIdentity, dmgPath]);
}

if (canNotarize) {
  run("xcrun", [
    "notarytool", "submit", dmgPath,
    "--apple-id", appleId,
    "--password", applePassword,
    "--team-id", appleTeamId,
    "--wait"
  ]);
  try {
    run("xcrun", ["stapler", "staple", dmgPath]);
  } catch {
    console.warn("DMG staple failed (non-fatal).");
  }
}
console.log(`DMG: ${dmgPath}`);

// ---------------------------------------------------------------------------
// 3. 创建 updater .tar.gz
// ---------------------------------------------------------------------------

console.log("\n=== Step 3: Create updater package ===");
const tarName = `${productName}.app.tar.gz`;
const tarPath = path.join(outputDir, tarName);

// tar 需要从 .app 的父目录打包，只包含 .app
run("tar", [
  "czf", tarPath,
  "-C", path.dirname(appPath),
  path.basename(appPath)
]);
console.log(`Updater package: ${tarPath}`);

// 用 Tauri 私钥签名
const sigPath = `${tarPath}.sig`;
if (tauriPrivateKey) {
  console.log("Signing updater package with TAURI_SIGNING_PRIVATE_KEY...");
  const tauriBin = path.join(rootDir, "node_modules", ".bin", "tauri");

  // tauri signer sign 通过环境变量读取私钥，签名输出到 stdout
  const signResult = spawnSync(tauriBin, ["signer", "sign", tarPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: tauriPrivateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: tauriPrivateKeyPassword || ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (signResult.status !== 0) {
    console.error("Signer failed:", (signResult.stderr || "").trim());
    // 签名写入 .sig 文件可能由 CLI 自动完成，也可能输出到 stdout
  }

  // tauri signer 会自动创建 .sig 文件，或输出签名到 stdout
  if (!existsSync(sigPath) && signResult.stdout?.trim()) {
    writeFileSync(sigPath, signResult.stdout.trim());
  }

  if (existsSync(sigPath)) {
    console.log(`Signature: ${sigPath}`);
  } else {
    console.error("ERROR: updater signature file not created. Updater will not work!");
    console.error("  stdout:", (signResult.stdout || "").slice(0, 200));
    console.error("  stderr:", (signResult.stderr || "").slice(0, 200));
    process.exit(1);
  }
} else {
  console.warn("TAURI_SIGNING_PRIVATE_KEY not set, skipping updater signature.");
}

// ---------------------------------------------------------------------------
// 4. 生成 latest.json
// ---------------------------------------------------------------------------

console.log("\n=== Step 4: Generate latest.json ===");

let signature = "";
try {
  signature = existsSync(sigPath) ? readFileSync(sigPath, "utf8").trim() : "";
} catch {}

// 从 updater endpoint 推断 GitHub Release 下载基础 URL
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
    [tauriTarget]: {
      signature,
      url: `${releaseBaseUrl}/${tarName}`
    }
  }
};

const latestPath = path.join(outputDir, "latest.json");
writeFileSync(latestPath, JSON.stringify(latestJson, null, 2) + "\n");
console.log(`latest.json: ${latestPath}`);

// ---------------------------------------------------------------------------
// 完成
// ---------------------------------------------------------------------------

console.log(`
=== Build complete ===
  .app : ${appPath}
  DMG  : ${dmgPath}
  Update: ${tarPath}${existsSync(sigPath) ? `\n  Sig  : ${sigPath}` : ""}
  JSON : ${latestPath}

Upload to GitHub Release:
  - ${dmgName}
  - ${tarName}${existsSync(sigPath) ? `\n  - ${path.basename(sigPath)}` : ""}
  - latest.json
`);
