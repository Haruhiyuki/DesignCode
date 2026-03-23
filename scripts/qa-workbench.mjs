import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = 4173;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForServer(url, timeoutMs = 20000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function collectDiagnostics(page) {
  const iframeLocator = page.locator(".frame-shell iframe");

  return {
    status: await page.locator(".status-pill").first().textContent().catch(() => null),
    warnings: await page.locator(".notice-card").allTextContents().catch(() => []),
    iframeCount: await iframeLocator.count().catch(() => 0),
    frameShellBox: await page.locator(".frame-shell").boundingBox().catch(() => null),
    scrollMetrics: await page.evaluate(() => ({
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      bodyOverflowY: window.getComputedStyle(document.body).overflowY
    }))
  };
}

async function main() {
  const server = spawn("node", ["app/server/index.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port)
    },
    stdio: "inherit"
  });

  try {
    await waitForServer(baseUrl);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1680, height: 1040 } });
    const errors = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    page.on("pageerror", (error) => {
      errors.push(error.message);
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });

    await page.locator("#composerInput").fill("做一张复古爵士音乐节海报，强调暖色舞台灯光和纸张质感。");
    const primaryAction = page
      .getByRole("button", { name: /^(生成首稿|提交给 Agent 生成)$/ })
      .first();
    await primaryAction.click();
    const iframeLocator = page.locator(".frame-shell iframe");
    let renderReady = true;

    try {
      await iframeLocator.waitFor({ state: "visible", timeout: 15000 });
    } catch {
      renderReady = false;
    }

    if (renderReady) {
      const frameHandle = await iframeLocator.elementHandle();
      const frame = await frameHandle?.contentFrame();
      await frame?.waitForLoadState("domcontentloaded");
    }

    const artifactsDir = path.join(rootDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const screenshotPath = path.join(artifactsDir, "workbench-smoke.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const diagnostics = await collectDiagnostics(page);
    console.log(JSON.stringify(diagnostics, null, 2));

    if (!renderReady) {
      throw new Error(`Preview iframe did not render.\n${JSON.stringify(diagnostics, null, 2)}`);
    }

    if (errors.length) {
      throw new Error(`Browser reported runtime errors:\n${errors.join("\n")}`);
    }

    console.log(`Saved screenshot to ${screenshotPath}`);
    await browser.close();
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
