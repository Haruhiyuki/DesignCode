import { readFile } from "node:fs/promises";
import { getCatalogSnapshot } from "../shared/catalog.js";
import {
  attachDesignSession,
  createDesignSession,
  deleteDesignSession,
  listDesignSessions,
  openDesignSession,
  prepareDesignSession,
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

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  const mode = process.argv[2];
  const payload = await readStdin();

  if (mode === "catalog") {
    process.stdout.write(JSON.stringify(getCatalogSnapshot()));
    return;
  }

  if (mode === "generate") {
    const result = await generateDesign(payload);
    const designState = await persistDesignResult(process.cwd(), payload, result, "generate");
    process.stdout.write(JSON.stringify({ ...result, ...designState }));
    return;
  }

  if (mode === "edit") {
    const result = await editDesign(payload);
    const designState = await persistDesignResult(process.cwd(), payload, result, "edit");
    process.stdout.write(JSON.stringify({ ...result, ...designState }));
    return;
  }

  if (mode === "design-list") {
    process.stdout.write(JSON.stringify(await listDesignSessions(process.cwd())));
    return;
  }

  if (mode === "design-create") {
    process.stdout.write(JSON.stringify(await createDesignSession(process.cwd(), payload)));
    return;
  }

  if (mode === "design-update") {
    process.stdout.write(
      JSON.stringify(await updateDesignSession(process.cwd(), payload.designId, payload))
    );
    return;
  }

  if (mode === "design-prepare") {
    process.stdout.write(JSON.stringify(await prepareDesignSession(process.cwd(), payload, payload.mode)));
    return;
  }

  if (mode === "design-open") {
    process.stdout.write(JSON.stringify(await openDesignSession(process.cwd(), payload.designId)));
    return;
  }

  if (mode === "design-delete") {
    process.stdout.write(JSON.stringify(await deleteDesignSession(process.cwd(), payload.designId)));
    return;
  }

  if (mode === "design-commit-read") {
    process.stdout.write(
      JSON.stringify(await readDesignCommit(process.cwd(), payload.designId, payload.commitHash))
    );
    return;
  }

  if (mode === "design-attach-session") {
    process.stdout.write(
      JSON.stringify(
        await attachDesignSession(
          process.cwd(),
          payload.designId,
          payload.sessionId,
          payload.runtimeBackend
        )
      )
    );
    return;
  }

  if (mode === "design-sync-workspace") {
    process.stdout.write(JSON.stringify(await syncDesignWorkspace(process.cwd(), payload)));
    return;
  }

  if (mode === "design-update-html") {
    process.stdout.write(JSON.stringify(await updateDesignHtml(process.cwd(), payload)));
    return;
  }

  if (mode === "art-assets-list") {
    process.stdout.write(JSON.stringify(await listArtAssets(process.cwd())));
    return;
  }

  if (mode === "art-asset-import") {
    process.stdout.write(JSON.stringify(await importArtAsset(process.cwd(), payload)));
    return;
  }

  if (mode === "art-asset-import-paths") {
    process.stdout.write(JSON.stringify(await importArtAssetsFromPaths(process.cwd(), payload)));
    return;
  }

  if (mode === "art-asset-update") {
    process.stdout.write(JSON.stringify(await updateArtAsset(process.cwd(), payload)));
    return;
  }

  if (mode === "art-asset-delete") {
    process.stdout.write(JSON.stringify(await deleteArtAsset(process.cwd(), payload)));
    return;
  }

  if (mode === "art-asset-preview") {
    process.stdout.write(JSON.stringify(await readArtAssetPreview(process.cwd(), payload)));
    return;
  }

  if (mode === "ping") {
    process.stdout.write(JSON.stringify({ ok: true }));
    return;
  }

  if (mode === "readme") {
    const content = await readFile("README.md", "utf8");
    process.stdout.write(JSON.stringify({ content }));
    return;
  }

  throw new Error(`Unknown bridge mode: ${mode || "undefined"}`);
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
