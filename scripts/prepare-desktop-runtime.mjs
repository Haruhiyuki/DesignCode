import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows"
};

const archMap = {
  x64: "x64",
  arm64: "arm64",
  arm: "arm"
};

const platform = platformMap[process.platform] || process.platform;
const arch = archMap[process.arch] || process.arch;
const runtimeKey = `${platform}-${arch}`;
const runtimeDir = path.join(rootDir, "src-tauri", "resources", "runtime", runtimeKey);

function runtimeBinaryName(baseName) {
  return platform === "windows" ? `${baseName}.exe` : baseName;
}

function supportsAvx2() {
  if (arch !== "x64") {
    return false;
  }

  if (platform === "linux") {
    try {
      return /(^|\\s)avx2(\\s|$)/i.test(execFileSync("cat", ["/proc/cpuinfo"], { encoding: "utf8" }));
    } catch {
      return false;
    }
  }

  if (platform === "darwin") {
    try {
      return execFileSync("sysctl", ["-n", "hw.optional.avx2_0"], { encoding: "utf8" }).trim() === "1";
    } catch {
      return false;
    }
  }

  if (platform === "windows") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)';

    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true
        });
        if (result.status !== 0) {
          continue;
        }

        const output = (result.stdout || "").trim().toLowerCase();
        if (output === "true" || output === "1") {
          return true;
        }
        if (output === "false" || output === "0") {
          return false;
        }
      } catch {
        continue;
      }
    }
  }

  return false;
}

function buildOpencodePackageNames() {
  const base = `opencode-${platform}-${arch}`;
  const avx2 = supportsAvx2();
  const baseline = arch === "x64" && !avx2;

  if (platform === "linux") {
    const musl = (() => {
      try {
        if (existsSync("/etc/alpine-release")) {
          return true;
        }
      } catch {}

      try {
        const result = spawnSync("ldd", ["--version"], { encoding: "utf8" });
        const text = `${result.stdout || ""}${result.stderr || ""}`.toLowerCase();
        return text.includes("musl");
      } catch {
        return false;
      }
    })();

    if (musl) {
      if (arch === "x64") {
        return baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`];
      }
      return [`${base}-musl`, base];
    }

    if (arch === "x64") {
      return baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`];
    }

    return [base, `${base}-musl`];
  }

  if (arch === "x64") {
    return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`];
  }

  return [base];
}

function findNodeModulesBinary(startDir, packageNames, fileName) {
  let current = startDir;

  for (;;) {
    const nodeModulesDir = path.join(current, "node_modules");
    if (existsSync(nodeModulesDir)) {
      for (const packageName of packageNames) {
        const candidate = path.join(nodeModulesDir, packageName, "bin", fileName);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

async function resolveNodeSource() {
  return realpath(process.execPath);
}

function normalizeWindowsCommandPath(commandPath) {
  if (platform !== "windows" || !commandPath) {
    return commandPath;
  }

  const normalized = String(commandPath).trim();
  if (!normalized) {
    return normalized;
  }

  const extension = path.extname(normalized).toLowerCase();
  const candidates = [];

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

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return normalized;
}

function resolveExplicitCommandPath(envKey) {
  const explicit = String(process.env[envKey] || "").trim();
  if (!explicit) {
    return null;
  }

  const normalized = normalizeWindowsCommandPath(explicit);
  return existsSync(normalized) ? realpathSync(normalized) : null;
}

function isLauncherScript(sourcePath) {
  const normalized = String(sourcePath || "").toLowerCase();
  return (
    normalized.endsWith(".js")
    || normalized.endsWith(".mjs")
    || normalized.endsWith(".cjs")
    || normalized.endsWith(".cmd")
    || normalized.endsWith(".bat")
    || normalized.endsWith(".ps1")
  );
}

function hasScriptShebang(filePath) {
  try {
    const fd = readFileSync(filePath, { encoding: "utf8", flag: "r" });
    const firstLine = fd.slice(0, 128).split("\n")[0];
    return /^#!.*\b(node|python|bash|sh|ruby|perl|env)\b/.test(firstLine);
  } catch {
    return false;
  }
}

function isNativeRuntimeBinary(sourcePath, baseName) {
  return (
    path.basename(String(sourcePath || "")).toLowerCase() === runtimeBinaryName(baseName).toLowerCase()
    && !isLauncherScript(sourcePath)
    && !hasScriptShebang(sourcePath)
  );
}

function resolveWindowsCommandPath(command) {
  if (platform !== "windows") {
    return null;
  }

  const searchDirs = [
    ...String(process.env.PATH || "")
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean),
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".local", "bin") : "",
    os.homedir() ? path.join(os.homedir(), "AppData", "Roaming", "npm") : ""
  ]
    .filter(Boolean)
    .filter((entry, index, list) => list.indexOf(entry) === index);

  const candidateNames = [
    command,
    `${command}.exe`,
    `${command}.cmd`,
    `${command}.bat`,
    `${command}.ps1`
  ];

  for (const dir of searchDirs) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      if (!existsSync(candidate)) {
        continue;
      }

      const normalized = normalizeWindowsCommandPath(candidate);
      return realpathSync(normalized);
    }
  }

  return null;
}

function resolveOpencodeSource() {
  const launcherPath = resolveExplicitCommandPath("OPENCODE_BIN_PATH") || resolveCommandPath("opencode");
  if (!launcherPath) {
    throw new Error("Unable to resolve OpenCode on the build machine. Install `opencode` or set OPENCODE_BIN_PATH.");
  }

  if (isNativeRuntimeBinary(launcherPath, "opencode")) {
    return launcherPath;
  }

  const launcherDir = path.dirname(launcherPath);
  const cachedBinary = [
    path.join(launcherDir, ".opencode"),
    path.join(launcherDir, ".opencode.exe")
  ].find((candidate) => existsSync(candidate));
  if (cachedBinary) {
    return realpathSync(cachedBinary);
  }

  const candidateStarts = [launcherDir];
  const siblingPackageRoot = path.join(launcherDir, "node_modules", "opencode-ai");
  if (existsSync(siblingPackageRoot)) {
    candidateStarts.unshift(realpathSync(siblingPackageRoot));
  }

  for (const startDir of candidateStarts) {
    const resolved = findNodeModulesBinary(
      startDir,
      buildOpencodePackageNames(),
      runtimeBinaryName("opencode")
    );

    if (resolved) {
      return realpathSync(resolved);
    }
  }

  throw new Error(`Unable to resolve the native OpenCode binary for ${runtimeKey}.`);
}

function findRecursiveFile(startDir, fileName, maxDepth = 6, predicate = () => true) {
  function visit(currentDir, depth) {
    if (depth > maxDepth) {
      return null;
    }

    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      const candidate = path.join(currentDir, entry.name);
      if (entry.isFile() && entry.name === fileName && predicate(candidate)) {
        return candidate;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const found = visit(path.join(currentDir, entry.name), depth + 1);
      if (found) {
        return found;
      }
    }

    return null;
  }

  return visit(startDir, 0);
}

function resolveCodexSource() {
  const launcherPath = resolveExplicitCommandPath("CODEX_BIN_PATH") || resolveCommandPath("codex");
  if (!launcherPath) {
    throw new Error("Unable to resolve Codex on the build machine. Install `codex` or set CODEX_BIN_PATH.");
  }

  if (isNativeRuntimeBinary(launcherPath, "codex")) {
    return launcherPath;
  }

  const candidateRoots = new Set();
  const launcherDir = path.dirname(launcherPath);
  const packageRoot = findPackageRoot(launcherPath, "@openai/codex");
  if (packageRoot) {
    candidateRoots.add(packageRoot);
  }

  const siblingPackageRoot = path.join(launcherDir, "node_modules", "@openai", "codex");
  if (existsSync(siblingPackageRoot)) {
    candidateRoots.add(realpathSync(siblingPackageRoot));
  }

  for (const root of candidateRoots) {
    const resolved = findRecursiveFile(
      root,
      runtimeBinaryName("codex"),
      8,
      (candidate) => candidate.includes(`${path.sep}vendor${path.sep}`)
    );
    if (resolved) {
      return realpathSync(resolved);
    }
  }

  throw new Error(`Unable to resolve the native Codex binary for ${runtimeKey}.`);
}

function resolveCommandPath(command) {
  const lookupCommand = platform === "windows" ? "where.exe" : "which";

  try {
    const output = execFileSync(lookupCommand, [command], { encoding: "utf8" }).trim();
    if (!output) {
      return null;
    }

    const [firstMatch] = output
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (!firstMatch) {
      return null;
    }

    const normalized = normalizeWindowsCommandPath(firstMatch);
    return realpathSync(normalized);
  } catch {
    if (platform !== "windows") {
      return null;
    }
  }

  const manualResolved = resolveWindowsCommandPath(command);
  if (manualResolved) {
    return manualResolved;
  }

  const psCommand =
    `$command = Get-Command ${JSON.stringify(command)} -ErrorAction SilentlyContinue | ` +
    "Select-Object -First 1 -ExpandProperty Source; " +
    'if ($command) { Write-Output $command }';

  for (const executable of ["pwsh.exe", "powershell.exe", "pwsh", "powershell"]) {
    try {
      const output = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", psCommand], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true
      }).trim();

      if (output) {
        const [firstMatch] = output
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (!firstMatch) {
          return null;
        }

        const normalized = normalizeWindowsCommandPath(firstMatch);
        return realpathSync(normalized);
      }
    } catch {}
  }

  return null;
}

function resolveClaudeSource() {
  console.warn("Claude Code is proprietary — skipping bundle. Users must install `claude` themselves.");
  return null;
}

function resolveGeminiSource() {
  const resolved = resolveExplicitCommandPath("GEMINI_BIN_PATH") || resolveCommandPath("gemini");
  if (!resolved) {
    throw new Error("Unable to resolve Gemini CLI on the build machine. Install `gemini` or set GEMINI_BIN_PATH.");
  }

  return resolved;
}

function readPackageJson(packageRoot) {
  try {
    return JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function findPackageRoot(startPath, packageName) {
  if (!startPath) {
    return null;
  }

  let current;
  try {
    const absolute = realpathSync(startPath);
    current = statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
  } catch {
    return null;
  }

  for (;;) {
    const manifest = readPackageJson(current);
    if (manifest?.name === packageName) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function resolveGeminiPackageRoot(sourcePath) {
  const packageRoot = findPackageRoot(sourcePath, "@google/gemini-cli");
  if (
    packageRoot &&
    path.basename(packageRoot) === "dist" &&
    existsSync(path.join(path.dirname(packageRoot), "node_modules"))
  ) {
    return path.dirname(packageRoot);
  }

  if (packageRoot) {
    return packageRoot;
  }

  let current;
  try {
    const absolute = realpathSync(sourcePath);
    current = statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
  } catch {
    return null;
  }

  for (;;) {
    const candidate = path.join(current, "node_modules", "@google", "gemini-cli");
    if (existsSync(path.join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function isStandaloneRuntime(sourcePath) {
  if (!sourcePath) {
    return false;
  }

  const normalized = sourcePath.toLowerCase();
  if (platform === "windows") {
    return normalized.endsWith(".exe");
  }

  return !normalized.endsWith(".js") && !normalized.endsWith(".mjs") && !normalized.endsWith(".cjs");
}

async function copyExecutable(sourcePath, destinationPath) {
  await mkdir(path.dirname(destinationPath), { recursive: true });

  let shouldCopy = true;
  try {
    const [sourceStat, destinationStat] = await Promise.all([
      stat(sourcePath),
      stat(destinationPath)
    ]);
    shouldCopy =
      sourceStat.size !== destinationStat.size ||
      Number(sourceStat.mtimeMs) > Number(destinationStat.mtimeMs) + 1000;
  } catch {}

  if (shouldCopy) {
    await copyFile(sourcePath, destinationPath);
  }

  if (platform !== "windows") {
    await chmod(destinationPath, 0o755);
  }

  return shouldCopy;
}

async function copyDirectory(sourcePath, destinationPath) {
  await mkdir(path.dirname(destinationPath), { recursive: true });

  let shouldCopy = true;
  try {
    const [sourceMeta, destinationMeta] = await Promise.all([
      stat(path.join(sourcePath, "package.json")),
      stat(path.join(destinationPath, "package.json"))
    ]);

    shouldCopy =
      Number(sourceMeta.mtimeMs) > Number(destinationMeta.mtimeMs) + 1000 ||
      sourceMeta.size !== destinationMeta.size;
  } catch {}

  if (shouldCopy) {
    await rm(destinationPath, { recursive: true, force: true });
    await cp(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      preserveTimestamps: true
    });
  }

  return shouldCopy;
}

async function pruneGeminiPackage(packageDir) {
  const nodeModules = path.join(packageDir, "node_modules");
  if (!existsSync(nodeModules)) {
    return;
  }

  let removedBytes = 0;

  async function removeGlob(dir, testFn) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (testFn(entry.name, true)) {
          const size = dirSize(full);
          await rm(full, { recursive: true, force: true });
          removedBytes += size;
        } else {
          await removeGlob(full, testFn);
        }
      } else if (testFn(entry.name, false)) {
        try {
          const s = statSync(full).size;
          await rm(full, { force: true });
          removedBytes += s;
        } catch {}
      }
    }
  }

  function dirSize(dir) {
    let total = 0;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          total += dirSize(full);
        } else {
          try { total += statSync(full).size; } catch {}
        }
      }
    } catch {}
    return total;
  }

  // 1. 删除 @opentelemetry 中的 ESM/ESNEXT 重复构建（~73MB）
  const otelDir = path.join(nodeModules, "@opentelemetry");
  if (existsSync(otelDir)) {
    await removeGlob(otelDir, (name, isDir) => isDir && (name === "esm" || name === "esnext"));
  }

  // 2. 删除 .map 源码映射文件（~35MB）
  await removeGlob(nodeModules, (name, isDir) => !isDir && name.endsWith(".map"));

  // 3. 删除 .d.ts 类型声明（~10MB）
  await removeGlob(nodeModules, (name, isDir) => !isDir && name.endsWith(".d.ts"));

  // 4. 删除文档和元数据文件
  await removeGlob(nodeModules, (name, isDir) => !isDir && /^(CHANGELOG|HISTORY|CHANGES|AUTHORS|CONTRIBUTORS)(\..*)?$/i.test(name));
  await removeGlob(nodeModules, (name, isDir) => !isDir && /^readme(\..+)?$/i.test(name));

  const mb = (removedBytes / 1024 / 1024).toFixed(1);
  console.log(`  Pruned Gemini node_modules: removed ${mb} MB of unnecessary files.`);
}

async function removeIfExists(targetPath) {
  if (!targetPath) {
    return;
  }

  await rm(targetPath, { recursive: true, force: true });
}

function readBinaryVersion(binaryPath) {
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000
  });
  if (result.error || result.signal || result.status !== 0) {
    return "";
  }

  return (result.stdout || "").trim();
}

// ---------------------------------------------------------------------------
// macOS 签名 — 对 resources/runtime 内所有原生二进制做 codesign，
// 否则 Apple 公证会因"未签名二进制"而拒绝。
// ---------------------------------------------------------------------------

function isMachOBinary(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    const bytesRead = readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    const magic = buf.readUInt32BE(0);
    return (
      magic === 0xFEEDFACE ||  // MH_MAGIC 32-bit
      magic === 0xFEEDFACF ||  // MH_MAGIC_64
      magic === 0xCEFAEDFE ||  // MH_CIGAM 32-bit reversed
      magic === 0xCFFAEDFE ||  // MH_CIGAM_64 reversed
      magic === 0xCAFEBABE ||  // FAT_MAGIC universal
      magic === 0xBEBAFECA     // FAT_CIGAM universal reversed
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function findNativeBinaries(dir) {
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
      if (!entry.isFile()) {
        continue;
      }

      // .node 原生插件：仅当是 Mach-O 格式时才签名（跳过 Windows/Linux 的）
      if (path.extname(entry.name).toLowerCase() === ".node") {
        if (isMachOBinary(fullPath)) {
          results.push(fullPath);
        }
        continue;
      }

      // 无扩展名的文件：用 Mach-O magic number 判断是否是原生二进制
      if (!path.extname(entry.name) && isMachOBinary(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function signMacOSRuntimeBinaries(baseDir, identity) {
  if (platform !== "darwin" || !identity) {
    return 0;
  }

  const binaries = findNativeBinaries(baseDir);
  if (!binaries.length) {
    return 0;
  }

  // JIT entitlements 文件路径 — node / codex / gemini 等运行时需要 JIT 权限
  const entitlementsPath = path.join(rootDir, "src-tauri", "resources", "runtime-entitlements.plist");
  const hasEntitlements = existsSync(entitlementsPath);
  if (!hasEntitlements) {
    console.warn("Warning: runtime-entitlements.plist not found, signing without entitlements (Node.js will crash under hardened runtime)");
  }

  console.log(`Signing ${binaries.length} native binaries for macOS notarization...`);
  let signed = 0;

  for (const binary of binaries) {
    const relative = path.relative(baseDir, binary);
    try {
      const args = [
        "--force",
        "--options", "runtime",
        "--timestamp",
        "--sign", identity
      ];
      // 可执行二进制（非 .node 插件）需要 JIT entitlements
      if (hasEntitlements && path.extname(binary).toLowerCase() !== ".node") {
        args.push("--entitlements", entitlementsPath);
      }
      args.push(binary);
      execFileSync("codesign", args, { stdio: "pipe" });
      console.log(`  Signed: ${relative}${args.includes("--entitlements") ? " (with JIT entitlements)" : ""}`);
      signed += 1;
    } catch (error) {
      const message = String(error.stderr || error.message || "").trim();
      console.warn(`  Skipped: ${relative} (${message || "codesign failed"})`);
    }
  }

  return signed;
}

async function main() {
  const nodeSource = await resolveNodeSource();
  const opencodeSource = resolveOpencodeSource();
  const codexSource = resolveCodexSource();
  const claudeSource = resolveClaudeSource(); // null if not found — proprietary, not bundled
  const geminiSource = resolveGeminiSource();
  const geminiPackageRoot = resolveGeminiPackageRoot(geminiSource);
  const bundleGeminiBinary = isStandaloneRuntime(geminiSource);
  const bundleGeminiPackage = Boolean(geminiPackageRoot && !bundleGeminiBinary);

  if (!bundleGeminiBinary && !bundleGeminiPackage) {
    throw new Error(
      "Unable to bundle Gemini CLI. Expected a standalone binary or an @google/gemini-cli package root."
    );
  }

  const nodeDestination = path.join(runtimeDir, "node", runtimeBinaryName("node"));
  const opencodeDestination = path.join(runtimeDir, "opencode", runtimeBinaryName("opencode"));
  const codexDestination = path.join(runtimeDir, "codex", runtimeBinaryName("codex"));
  const claudeDestination = claudeSource ? path.join(runtimeDir, "claude", runtimeBinaryName("claude")) : null;
  const geminiDestination = path.join(runtimeDir, "gemini", runtimeBinaryName("gemini"));
  const geminiPackageDestination = path.join(runtimeDir, "gemini", "package");

  const [nodeCopied, opencodeCopied, codexCopied, claudeCopied, geminiCopied] = await Promise.all([
    copyExecutable(nodeSource, nodeDestination),
    copyExecutable(opencodeSource, opencodeDestination),
    copyExecutable(codexSource, codexDestination),
    claudeSource && claudeDestination
      ? copyExecutable(claudeSource, claudeDestination)
      : removeIfExists(path.join(runtimeDir, "claude")).then(() => false),
    bundleGeminiBinary
      ? Promise.all([
          removeIfExists(geminiPackageDestination),
          copyExecutable(geminiSource, geminiDestination)
        ]).then(([, copied]) => copied)
      : bundleGeminiPackage
        ? Promise.all([
            removeIfExists(geminiDestination),
            copyDirectory(geminiPackageRoot, geminiPackageDestination)
          ]).then(async ([, copied]) => {
            await pruneGeminiPackage(geminiPackageDestination);
            return copied;
          })
        : Promise.resolve(false)
  ]);

  const manifest = {
    preparedAt: new Date().toISOString(),
    runtimeKey,
    node: {
      version: process.version,
      source: nodeSource,
      destination: nodeDestination,
      copied: nodeCopied
    },
    opencode: {
      version: readBinaryVersion(opencodeSource),
      source: opencodeSource,
      destination: opencodeDestination,
      copied: opencodeCopied
    },
    codex: {
      version: readBinaryVersion(codexSource),
      source: codexSource,
      destination: codexDestination,
      copied: codexCopied
    },
    claude: {
      version: claudeSource ? readBinaryVersion(claudeSource) : "",
      source: claudeSource || null,
      destination: claudeDestination || null,
      copied: claudeCopied,
      bundled: Boolean(claudeSource),
      note: claudeSource ? "" : "Proprietary — not bundled. Users must install Claude Code separately."
    },
    gemini: {
      version: bundleGeminiPackage
        ? readPackageJson(geminiPackageRoot)?.version || ""
        : geminiSource
          ? readBinaryVersion(geminiSource)
          : "",
      source: bundleGeminiPackage ? geminiPackageRoot : geminiSource,
      destination: bundleGeminiBinary
        ? geminiDestination
        : bundleGeminiPackage
          ? geminiPackageDestination
          : null,
      copied: geminiCopied,
      bundledAs: bundleGeminiBinary ? "binary" : "node-package"
    }
  };

  await writeFile(
    path.join(runtimeDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  console.log(`Prepared bundled desktop runtime for ${runtimeKey}`);
  console.log(`Node: ${nodeDestination}`);
  console.log(`OpenCode: ${opencodeDestination}`);
  console.log(`Codex: ${codexDestination}`);
  console.log(`Claude: ${claudeDestination || "(not bundled — proprietary license, requires user install)"}`);

  console.log(
    `Gemini: ${
      bundleGeminiBinary
        ? geminiDestination
        : `${geminiPackageDestination} (bundled node package)`
    }`
  );

  // macOS: 仅在 --sign 标志下对原生二进制做 codesign（公证要求）
  if (process.argv.includes("--sign")) {
    const signingIdentity = (process.env.APPLE_SIGNING_IDENTITY || "").trim();
    if (!signingIdentity) {
      console.warn("--sign specified but APPLE_SIGNING_IDENTITY is not set, skipping codesign.");
    } else {
      const signedCount = signMacOSRuntimeBinaries(runtimeDir, signingIdentity);
      if (signedCount) {
        console.log(`Signed ${signedCount} native binaries with "${signingIdentity}"`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
