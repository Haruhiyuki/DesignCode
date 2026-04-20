// CI 用：发版成功后清理 R2 bucket 里过旧的版本产物，控制总占用不超过 10 GB
// 免费额度。每个版本约 200-300 MB × 3 平台，保留 2-3 个版本就够回滚用。
//
// 保留策略：
//   - 不动 latest.json（固定 key，始终覆盖）
//   - 按"文件名里的 X.Y.Z"归组，保留最近 RETAIN_VERSIONS 个版本
//   - 当前发版的版本（CURRENT_VERSION）无条件保留，防止并发时刚上传又被删
//   - 认不出版本号的文件（无 `_X.Y.Z` 片段）默认跳过，不动
//
// 环境变量：
//   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
//   CURRENT_VERSION  本次发版的版本（不带 v 前缀）；通常和上传脚本共用 VERSION
//   RETAIN_VERSIONS  保留的版本数，默认 2
//   DRY_RUN          "1" 时只打印打算删什么，不真删
//
// 用法：CURRENT_VERSION=$VERSION node scripts/ci-prune-r2.mjs

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  CURRENT_VERSION = process.env.VERSION || "",
  RETAIN_VERSIONS = "2",
  DRY_RUN = ""
} = process.env;

for (const [key, val] of Object.entries({
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET
})) {
  if (!val) {
    console.error(`Missing env: ${key}`);
    process.exit(1);
  }
}

const retain = Math.max(1, Number.parseInt(RETAIN_VERSIONS, 10) || 2);
const currentVersion = String(CURRENT_VERSION || "").replace(/^v/, "").trim();
const dryRun = DRY_RUN === "1" || DRY_RUN.toLowerCase() === "true";

const client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

// ---------------------------------------------------------------------------
// 列出 bucket 所有对象（分页拉完）
// ---------------------------------------------------------------------------

async function listAllObjects() {
  const objects = [];
  let continuationToken;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        ContinuationToken: continuationToken
      })
    );
    for (const obj of res.Contents || []) {
      if (obj.Key) objects.push({ key: obj.Key, size: Number(obj.Size || 0) });
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

// ---------------------------------------------------------------------------
// 从 key 里抽版本号；DesignCode_1.1.5_aarch64.dmg / *_x64-setup.exe 等都能命中
// ---------------------------------------------------------------------------

function extractVersion(key) {
  // 匹配下划线包起来的 semver：支持 prerelease/build 后缀（1.2.3-beta.1）。
  // 注意 prerelease 部分不能匹配下划线（\w 会吞 `_` 把后面的平台名也拉进来），
  // 因此用 [A-Za-z0-9.-] 显式列出允许字符。
  const m = key.match(/_(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)[_.]/);
  return m ? m[1] : null;
}

function compareSemver(a, b) {
  const parse = (v) => {
    const [core, pre = ""] = v.split(/[-+]/, 2);
    const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return { parts, pre };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (A.parts[i] !== B.parts[i]) return A.parts[i] - B.parts[i];
  }
  // 无 prerelease > 有 prerelease（1.2.3 > 1.2.3-beta）
  if (!A.pre && B.pre) return 1;
  if (A.pre && !B.pre) return -1;
  return A.pre.localeCompare(B.pre);
}

// ---------------------------------------------------------------------------
// 按版本归组、选出要删的 key
// ---------------------------------------------------------------------------

const objects = await listAllObjects();

const byVersion = new Map(); // version -> [{key, size}]
const skipped = [];
for (const obj of objects) {
  if (obj.key === "latest.json") {
    skipped.push({ ...obj, reason: "reserved" });
    continue;
  }
  const version = extractVersion(obj.key);
  if (!version) {
    skipped.push({ ...obj, reason: "unknown-version" });
    continue;
  }
  if (!byVersion.has(version)) byVersion.set(version, []);
  byVersion.get(version).push(obj);
}

const versions = [...byVersion.keys()].sort((a, b) => compareSemver(b, a));

const keepSet = new Set(versions.slice(0, retain));
if (currentVersion) keepSet.add(currentVersion);

const toDelete = [];
const toKeep = [];
for (const version of versions) {
  const bucket = keepSet.has(version) ? toKeep : toDelete;
  for (const obj of byVersion.get(version)) bucket.push({ ...obj, version });
}

// ---------------------------------------------------------------------------
// 输出计划
// ---------------------------------------------------------------------------

function fmtMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const totalBytes = objects.reduce((a, b) => a + b.size, 0);
const keepBytes = toKeep.reduce((a, b) => a + b.size, 0);
const skipBytes = skipped.reduce((a, b) => a + b.size, 0);
const deleteBytes = toDelete.reduce((a, b) => a + b.size, 0);

console.log(`R2 bucket: ${R2_BUCKET}`);
console.log(`  total ${objects.length} objects, ${fmtMb(totalBytes)}`);
console.log(`  found ${versions.length} versions: ${versions.join(", ") || "(none)"}`);
console.log(`  retaining latest ${retain} + current=${currentVersion || "(none)"}`);
console.log(`  keep:   ${toKeep.length} objects (${fmtMb(keepBytes)})`);
console.log(`  skip:   ${skipped.length} objects (${fmtMb(skipBytes)})  [latest.json / 无版本号]`);
console.log(`  delete: ${toDelete.length} objects (${fmtMb(deleteBytes)})`);

if (toDelete.length) {
  console.log("\n  将删除：");
  for (const obj of toDelete.slice(0, 30)) {
    console.log(`    - ${obj.key}  (${obj.version}, ${fmtMb(obj.size)})`);
  }
  if (toDelete.length > 30) {
    console.log(`    ... ${toDelete.length - 30} more`);
  }
}

if (dryRun) {
  console.log("\n[DRY_RUN] 不执行删除。");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 批量删除（S3 DeleteObjects 一次最多 1000 个）
// ---------------------------------------------------------------------------

if (!toDelete.length) {
  console.log("\n✓ 没有需要清理的旧版本。");
  process.exit(0);
}

const CHUNK = 1000;
let failed = 0;
for (let i = 0; i < toDelete.length; i += CHUNK) {
  const chunk = toDelete.slice(i, i + CHUNK);
  try {
    const res = await client.send(
      new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: {
          Objects: chunk.map((obj) => ({ Key: obj.key })),
          Quiet: true
        }
      })
    );
    if (res.Errors && res.Errors.length) {
      failed += res.Errors.length;
      for (const err of res.Errors) {
        console.error(`  ✗ ${err.Key}: ${err.Code} ${err.Message || ""}`);
      }
    }
  } catch (err) {
    failed += chunk.length;
    console.error(`  ✗ batch delete failed: ${err.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} delete(s) failed.`);
  process.exit(1);
}

console.log(`\n✓ 清理完成：删除 ${toDelete.length} 个对象，释放 ${fmtMb(deleteBytes)}。`);
