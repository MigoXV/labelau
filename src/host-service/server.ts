import path from "node:path";

import express from "express";

import { SERVICE_PORT } from "../shared/constants";
import type { SaveAnnotationRequest } from "../shared/contracts";

import { scanCorpus } from "../host-core/corpus";
import { loadDocument, saveAnnotation } from "../host-core/documents";

const app = express();

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

app.post("/api/scanDirectory", async (request, response) => {
  try {
    const rootPath = String(request.body?.rootPath ?? "");
    if (!rootPath) {
      response.status(400).json({ error: "rootPath is required" });
      return;
    }

    const tree = await scanCorpus(rootPath);
    response.json(tree);
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

app.get("/api/audio", (request, response) => {
  const audioPath = String(request.query.audioPath ?? "");
  if (!audioPath) {
    response.status(400).json({ error: "audioPath is required" });
    return;
  }

  response.sendFile(path.resolve(audioPath));
});

app.listen(SERVICE_PORT, () => {
  console.log(`LabelAU host service listening on http://localhost:${SERVICE_PORT}`);
});
