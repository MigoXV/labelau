import path from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import crypto from "node:crypto";

import express from "express";
import multer from "multer";

import { SERVICE_PORT } from "../shared/constants";
import type {
  ExportAudioFolderRequest,
  SaveAnnotationRequest,
} from "../shared/contracts";
import { getAudioMimeType, isSupportedAudioFile } from "../shared/audio-format";

import {
  cleanupExportedArchive,
  exportAudioFolderArchive,
} from "../host-core/audiofolder-export";
import { scanCorpus } from "../host-core/corpus";
import { loadDocument, saveAnnotation } from "../host-core/documents";
import {
  denoiseAudio,
  getDenoisedAudio,
  getEngineConfigDefaults,
  runVadPreannotation,
  testEngineConnection,
} from "../host-core/engines";
import { listServerDirectory } from "../host-core/server-files";

const app = express();
const upload = multer({ dest: path.join(process.cwd(), ".labelau-upload-tmp") });
const exportedArchives = new Map<
  string,
  { fileName: string; zipPath: string }
>();

function parseRelativePaths(rawValue: unknown): string[] {
  if (typeof rawValue !== "string") {
    return [];
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsedValue)) {
      return [];
    }
    return parsedValue.map((value) => (typeof value === "string" ? value : ""));
  } catch {
    return [];
  }
}

function getSafeImportPath(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = relativePath.replaceAll("\\", "/");
  const safeRelativePath =
    normalizedRelativePath && !path.isAbsolute(normalizedRelativePath)
      ? normalizedRelativePath
      : path.basename(normalizedRelativePath);
  const destinationPath = path.resolve(rootPath, safeRelativePath);
  const relativeToRoot = path.relative(rootPath, destinationPath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`非法导入路径：${relativePath}`);
  }

  return destinationPath;
}

app.use((request, response, next) => {
  response.header("Access-Control-Allow-Origin", "*");
  response.header("Access-Control-Allow-Headers", "Content-Type");
  response.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/listServerDirectory", async (request, response) => {
  try {
    const requestedPath =
      typeof request.body?.path === "string" ? request.body.path : undefined;
    response.json(await listServerDirectory(requestedPath));
  } catch (error) {
    response.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to list server directory",
    });
  }
});

app.post("/api/scanDirectory", async (request, response) => {
  try {
    const rootPath = String(request.body?.rootPath ?? "");
    if (!rootPath) {
      response.status(400).json({ error: "rootPath is required" });
      return;
    }

    const result = await scanCorpus(rootPath);
    response.json(result);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to scan directory",
    });
  }
});

app.post("/api/loadDocument", async (request, response) => {
  try {
    const audioPath = String(request.body?.audioPath ?? "");
    if (!audioPath) {
      response.status(400).json({ error: "audioPath is required" });
      return;
    }

    const document = await loadDocument(audioPath, (resolvedAudioPath) => {
      const params = new URLSearchParams({ audioPath: resolvedAudioPath });
      return `/api/audio?${params.toString()}`;
    });

    response.json(document);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load document",
    });
  }
});

app.post("/api/saveAnnotation", async (request, response) => {
  try {
    const payload = request.body as SaveAnnotationRequest;
    if (!payload?.audioPath) {
      response.status(400).json({ error: "audioPath is required" });
      return;
    }

    const result = await saveAnnotation(payload);
    response.json(result);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to save annotation",
    });
  }
});

app.post("/api/runVadPreannotation", async (request, response) => {
  try {
    const audioPath = String(request.body?.audioPath ?? "");
    if (!audioPath) {
      response.status(400).json({ error: "audioPath is required" });
      return;
    }

    const segments = await runVadPreannotation({
      audioPath,
      audioContentBase64:
        typeof request.body?.audioContentBase64 === "string"
          ? request.body.audioContentBase64
          : undefined,
      vadGrpcUrl:
        typeof request.body?.vadGrpcUrl === "string"
          ? request.body.vadGrpcUrl
          : undefined,
    });
    response.json(segments);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to run VAD",
    });
  }
});

app.post("/api/denoiseAudio", async (request, response) => {
  try {
    const audioPath = String(request.body?.audioPath ?? "");
    if (!audioPath) {
      response.status(400).json({ error: "audioPath is required" });
      return;
    }

    const result = await denoiseAudio(
      audioPath,
      (id) => {
        const params = new URLSearchParams({ id });
        return `/api/denoisedAudio?${params.toString()}`;
      },
      typeof request.body?.denoiseGrpcUrl === "string"
        ? request.body.denoiseGrpcUrl
        : undefined,
    );
    response.json(result);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to denoise audio",
    });
  }
});

app.get("/api/engineConfigDefaults", (_request, response) => {
  response.json(getEngineConfigDefaults());
});

app.post("/api/testEngineConnection", async (request, response) => {
  try {
    const engine = request.body?.engine === "denoise" ? "denoise" : "vad";
    const grpcUrl =
      typeof request.body?.grpcUrl === "string" ? request.body.grpcUrl : undefined;
    response.json(await testEngineConnection({ engine, grpcUrl }));
  } catch (error) {
    response.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to test engine connection",
    });
  }
});

app.post("/api/importAudioFiles", upload.array("files"), async (request, response) => {
  const uploadedFiles = (request.files ?? []) as Express.Multer.File[];
  const relativePaths = parseRelativePaths(request.body?.relativePaths);
  let importedCount = 0;
  let skippedCount = 0;

  try {
    const rawRootPath = String(request.body?.rootPath ?? "");
    if (!rawRootPath) {
      response.status(400).json({ error: "rootPath is required" });
      return;
    }
    const rootPath = path.resolve(rawRootPath);

    await mkdir(rootPath, { recursive: true });

    for (const [index, file] of uploadedFiles.entries()) {
      const importRelativePath = relativePaths[index] || file.originalname;
      if (!isSupportedAudioFile(importRelativePath)) {
        skippedCount += 1;
        await rm(file.path, { force: true });
        continue;
      }

      const destinationPath = getSafeImportPath(rootPath, importRelativePath);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await rename(file.path, destinationPath);
      importedCount += 1;
    }

    response.json({
      importedCount,
      skippedCount,
      rootPath,
      message: `已导入 ${importedCount} 个音频${
        skippedCount ? `，跳过 ${skippedCount} 个不支持文件` : ""
      }`,
    });
  } catch (error) {
    await Promise.all(
      uploadedFiles.map((file) => rm(file.path, { force: true }).catch(() => undefined)),
    );
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to import audio files",
    });
  }
});

app.post("/api/exportAudioFolder", async (request, response) => {
  try {
    const payload = request.body as ExportAudioFolderRequest;
    if (!payload?.rootPath) {
      response.status(400).json({ error: "rootPath is required" });
      return;
    }

    const result = await exportAudioFolderArchive({
      rootPath: payload.rootPath,
      audioPaths: Array.isArray(payload.audioPaths) ? payload.audioPaths : [],
      splitName: payload.splitName === "test" ? "test" : "test",
    });
    const token = crypto.randomUUID();
    exportedArchives.set(token, {
      fileName: result.fileName,
      zipPath: result.zipPath,
    });

    response.json({
      exportedCount: result.exportedCount,
      fileName: result.fileName,
      downloadUrl: `/api/exportAudioFolder/${token}`,
    });
  } catch (error) {
    response.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to export AudioFolder",
    });
  }
});

app.get("/api/audio", (request, response) => {
  const audioPath = String(request.query.audioPath ?? "");
  if (!audioPath) {
    response.status(400).json({ error: "audioPath is required" });
    return;
  }

  response.type(getAudioMimeType(audioPath));
  response.sendFile(path.resolve(audioPath));
});

app.get("/api/denoisedAudio", (request, response) => {
  const id = String(request.query.id ?? "");
  const bytes = id ? getDenoisedAudio(id) : null;
  if (!bytes) {
    response.status(404).json({ error: "Denoised audio not found" });
    return;
  }

  response.type("audio/wav");
  response.send(bytes);
});

app.get("/api/exportAudioFolder/:token", (request, response) => {
  const token = String(request.params.token ?? "");
  const archive = token ? exportedArchives.get(token) : null;
  if (!archive) {
    response.status(404).json({ error: "AudioFolder export not found" });
    return;
  }

  const cleanup = async () => {
    exportedArchives.delete(token);
    await cleanupExportedArchive(archive.zipPath).catch(() => undefined);
  };

  response.download(archive.zipPath, archive.fileName, async (error) => {
    await cleanup();
    if (!response.headersSent) {
      response.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to download AudioFolder zip",
      });
    }
  });
});

app.listen(SERVICE_PORT, () => {
  console.log(`LabelAU host service listening on http://localhost:${SERVICE_PORT}`);
});
