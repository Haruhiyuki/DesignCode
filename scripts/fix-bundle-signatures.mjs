// 在 tauri build（无签名模式）之后运行：签名 bundle 内所有原生二进制。
// Tauri 构建时屏蔽了 APPLE_SIGNING_IDENTITY 以阻止其自动签名+公证，
// 此脚本手动完成签名：JIT 二进制附加 entitlements，其余常规签名。

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const entitlementsPath = path.join(rootDir, "src-tauri", "resources", "runtime-entitlements.plist");

const signingIdentity = (process.env.APPLE_SIGNING_IDENTITY || "").trim();
if (!signingIdentity) {
  console.log("APPLE_SIGNING_IDENTITY not set, skipping bundle signing.");
  process.exit(0);
}

if (!existsSync(entitlementsPath)) {
  console.error("runtime-entitlements.plist not found at", entitlementsPath);
  process.exit(1);
}

// `tauri build --target X` 会把产物写到 target/{target}/release/bundle/macos；
// 不带 --target 时写到 target/release/bundle/macos。两处都要找。
function resolveBundleBase() {
  const candidates = [
    path.join(rootDir, "src-tauri", "target", "release", "bundle", "macos")
  ];
  const targetRoot = path.join(rootDir, "src-tauri", "target");
  try {
    for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "release" || entry.name === "debug") continue;
      candidates.push(path.join(targetRoot, entry.name, "release", "bundle", "macos"));
    }
  } catch {}
  return candidates.find((candidate) => existsSync(candidate));
}

const bundleBase = resolveBundleBase();
if (!bundleBase) {
  console.error("Bundle directory not found under src-tauri/target/**/release/bundle/macos");
  process.exit(1);
}
console.log(`Bundle base: ${path.relative(rootDir, bundleBase)}`);

const appBundles = readdirSync(bundleBase)
  .filter((name) => name.endsWith(".app"))
  .map((name) => path.join(bundleBase, name));

if (!appBundles.length) {
  console.error("No .app bundles found in", bundleBase);
  process.exit(1);
}

function isMachOBinary(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    const bytesRead = readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    const magic = buf.readUInt32BE(0);
    return (
      magic === 0xFEEDFACE ||
      magic === 0xFEEDFACF ||
      magic === 0xCEFAEDFE ||
      magic === 0xCFFAEDFE ||
      magic === 0xCAFEBABE ||
      magic === 0xBEBAFECA
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// 需要 JIT entitlements 的二进制（无扩展名的可执行文件）
const JIT_BINARY_NAMES = new Set(["node", "codex", "opencode", "claude", "spawn-helper"]);

function needsJitEntitlements(filePath) {
  const name = path.basename(filePath);
  const ext = path.extname(name).toLowerCase();
  // .node 原生模块不需要 JIT entitlements
  if (ext === ".node") return false;
  // 无扩展名的可执行二进制，按名称判断
  return !ext && JIT_BINARY_NAMES.has(name);
}

function findAllNativeBinaries(dir) {
  const results = [];
  function walk(currentDir) {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".node" && isMachOBinary(fullPath)) {
        results.push(fullPath);
      } else if (!ext && isMachOBinary(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

for (const appBundle of appBundles) {
  console.log(`\nSigning ${path.basename(appBundle)}...`);

  // 1. 签名 Resources 内所有原生二进制（由内向外，先签最深层）
  const resourcesDir = path.join(appBundle, "Contents", "Resources");
  const binaries = findAllNativeBinaries(resourcesDir);
  console.log(`  Found ${binaries.length} native binaries in Resources`);

  let signedCount = 0;
  for (const binary of binaries) {
    const relative = path.relative(appBundle, binary);
    const withEntitlements = needsJitEntitlements(binary);
    const args = [
      "--force",
      "--options", "runtime",
      "--timestamp",
      "--sign", signingIdentity
    ];
    if (withEntitlements) {
      args.push("--entitlements", entitlementsPath);
    }
    args.push(binary);

    try {
      execFileSync("codesign", args, { stdio: "pipe" });
      console.log(`  Signed: ${relative}${withEntitlements ? " (JIT)" : ""}`);
      signedCount++;
    } catch (error) {
      const message = String(error.stderr || error.message || "").trim();
      console.error(`  Failed: ${relative} (${message})`);
      process.exit(1);
    }
  }

  // 2. 签名主可执行文件
  const mainBinary = path.join(appBundle, "Contents", "MacOS", "designcode-desktop");
  if (existsSync(mainBinary)) {
    try {
      execFileSync("codesign", [
        "--force",
        "--options", "runtime",
        "--timestamp",
        "--sign", signingIdentity,
        mainBinary
      ], { stdio: "pipe" });
      console.log(`  Signed: Contents/MacOS/designcode-desktop`);
      signedCount++;
    } catch (error) {
      const message = String(error.stderr || error.message || "").trim();
      console.error(`  Failed to sign main binary: ${message}`);
      process.exit(1);
    }
  }

  // 3. 签名整个 .app bundle
  try {
    execFileSync("codesign", [
      "--force",
      "--options", "runtime",
      "--timestamp",
      "--sign", signingIdentity,
      appBundle
    ], { stdio: "pipe" });
    console.log(`  Signed app bundle: ${path.basename(appBundle)}`);
  } catch (error) {
    const message = String(error.stderr || error.message || "").trim();
    console.error(`  Failed to sign app bundle: ${message}`);
    process.exit(1);
  }

  // 4. 验证
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", appBundle], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (verify.status === 0) {
    console.log(`  Verification passed. (${signedCount} binaries signed)`);
  } else {
    console.error(`  Verification failed: ${(verify.stderr || "").trim()}`);
    process.exit(1);
  }
}

console.log("\nBundle signing complete.");
