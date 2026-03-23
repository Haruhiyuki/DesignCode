import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCatalogSnapshot } from "../shared/catalog.js";
import {
  attachDesignSession,
  createDesignSession,
  deleteDesignSession,
  listDesignSessions,
  openDesignSession,
  persistDesignResult,
  readDesignCommit,
  syncDesignWorkspace,
  updateDesignHtml,
  updateDesignSession
} from "./design-sessions.js";
import {
  deleteArtAsset,
  importArtAsset,
  importArtAssetsFromPaths,
  listArtAssets,
  readArtAssetPreview,
  updateArtAsset
} from "./art-assets.js";
import { editDesign, generateDesign } from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../../dist");
const publicDir = distDir;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleApi(request, response, pathname) {
  try {
    if (request.method === "GET" && pathname === "/api/catalog") {
      sendJson(response, 200, getCatalogSnapshot());
      return true;
    }

    if (request.method === "POST" && pathname === "/api/design/generate") {
      const payload = await readJsonBody(request);
      const result = await generateDesign(payload);
      const designState = await persistDesignResult(process.cwd(), payload, result, "generate");
      sendJson(response, 200, { ...result, ...designState });
      return true;
    }

    if (request.method === "POST" && pathname === "/api/design/edit") {
      const payload = await readJsonBody(request);
      const result = await editDesign(payload);
      const designState = await persistDesignResult(process.cwd(), payload, result, "edit");
      sendJson(response, 200, { ...result, ...designState });
      return true;
    }

    if (request.method === "GET" && pathname === "/api/designs") {
      sendJson(response, 200, await listDesignSessions(process.cwd()));
      return true;
    }

    if (request.method === "POST" && pathname === "/api/designs") {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await createDesignSession(process.cwd(), payload));
      return true;
    }

    if (request.method === "DELETE" && pathname.startsWith("/api/designs/")) {
      const match = pathname.match(/^\/api\/designs\/([^/]+)$/);
      if (match?.[1]) {
        sendJson(response, 200, await deleteDesignSession(process.cwd(), decodeURIComponent(match[1])));
        return true;
      }
    }

    if (request.method === "POST" && pathname === "/api/designs/attach-session") {
      const payload = await readJsonBody(request);
      sendJson(
        response,
        200,
        await attachDesignSession(
          process.cwd(),
          payload.designId,
          payload.sessionId,
          payload.runtimeBackend
        )
      );
      return true;
    }

    if (request.method === "POST" && pathname === "/api/designs/sync-workspace") {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await syncDesignWorkspace(process.cwd(), payload));
      return true;
    }

    if (request.method === "POST" && pathname === "/api/designs/update-html") {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await updateDesignHtml(process.cwd(), payload));
      return true;
    }

    if ((request.method === "GET" || request.method === "PUT") && pathname.startsWith("/api/designs/")) {
      const match = pathname.match(
        /^\/api\/designs\/([^/]+?)(?:\/commits\/([^/]+))?$/
      );

      if (request.method === "PUT" && match?.[1] && !match?.[2]) {
        const payload = await readJsonBody(request);
        sendJson(
          response,
          200,
          await updateDesignSession(process.cwd(), decodeURIComponent(match[1]), payload)
        );
        return true;
      }

      if (match?.[1] && match?.[2]) {
        sendJson(
          response,
          200,
          await readDesignCommit(
            process.cwd(),
            decodeURIComponent(match[1]),
            decodeURIComponent(match[2])
          )
        );
        return true;
      }

      if (match?.[1]) {
        sendJson(response, 200, await openDesignSession(process.cwd(), decodeURIComponent(match[1])));
        return true;
      }
    }

    if (request.method === "GET" && pathname === "/api/art-assets") {
      sendJson(response, 200, await listArtAssets(process.cwd()));
      return true;
    }

    if (request.method === "POST" && pathname === "/api/art-assets/import") {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await importArtAsset(process.cwd(), payload));
      return true;
    }

    if (request.method === "POST" && pathname === "/api/art-assets/import-paths") {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await importArtAssetsFromPaths(process.cwd(), payload));
      return true;
    }

    if (request.method === "POST" && pathname === "/api/art-assets/update") {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await updateArtAsset(process.cwd(), payload));
      return true;
    }

    if (request.method === "POST" && pathname === "/api/art-assets/delete") {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await deleteArtAsset(process.cwd(), payload));
      return true;
    }

    if (request.method === "POST" && pathname === "/api/art-assets/preview") {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await readArtAssetPreview(process.cwd(), payload));
      return true;
    }

    sendError(response, 404, "API route not found");
    return true;
  } catch (error) {
    sendError(response, 500, error instanceof Error ? error.message : "Unknown server error");
    return true;
  }
}

async function serveFile(request, response, pathname) {
  if (!existsSync(publicDir)) {
    response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    response.end(
      [
        "<!DOCTYPE html>",
        "<html lang=\"zh-CN\">",
        "<head><meta charset=\"UTF-8\" /><title>Frontend Build Missing</title></head>",
        "<body style=\"font-family: sans-serif; padding: 32px;\">",
        "<h1>Frontend build is missing.</h1>",
        "<p>Run <code>npm run frontend:build</code> or start <code>npm run frontend:dev</code> before opening the app.</p>",
        "</body>",
        "</html>"
      ].join("")
    );
    return;
  }

  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    const indexFile = path.join(publicDir, "index.html");
    const html = await readFile(indexFile, "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    "content-type": contentTypes[ext] || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=300"
  });
  createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (pathname.startsWith("/api/")) {
    await handleApi(request, response, pathname);
    return;
  }

  await serveFile(request, response, pathname);
});

server.listen(port, host, () => {
  console.log(`DesignCode MVP server running at http://${host}:${port}`);
});

// ---------------------------------------------------------------------------
// 收到终止信号时立即退出（开发服务器无需等待连接排空）
// ---------------------------------------------------------------------------
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
