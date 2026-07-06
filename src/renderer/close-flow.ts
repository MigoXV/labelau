import type {
  AnnotationSegment,
  SaveAnnotationRequest,
  SaveAnnotationResult,
} from "../shared/contracts";

export interface DirtyDocumentForSave {
  audioPath: string;
  csvPath: string | null;
  annotationPath?: string | null;
  segments: AnnotationSegment[];
  stem: string;
}

export interface SavedDirtyDocument {
  audioPath: string;
  csvPath: string;
  annotationPath?: string;
  stem: string;
}

interface SaveDirtyDocumentsOptions {
  dirtyPaths: Iterable<string>;
  documentsByPath: ReadonlyMap<string, DirtyDocumentForSave>;
  saveAnnotation: (
    request: SaveAnnotationRequest,
  ) => Promise<SaveAnnotationResult>;
  onSaved?: (document: SavedDirtyDocument) => void | Promise<void>;
}

export async function saveDirtyDocuments({
  dirtyPaths,
  documentsByPath,
  saveAnnotation,
  onSaved,
}: SaveDirtyDocumentsOptions): Promise<SavedDirtyDocument[]> {
  const savedDocuments: SavedDirtyDocument[] = [];

  for (const audioPath of dirtyPaths) {
    const document = documentsByPath.get(audioPath);
    if (!document) {
      continue;
    }

    const result = await saveAnnotation({
      audioPath: document.audioPath,
      csvPath: document.csvPath,
      annotationPath: document.annotationPath,
      segments: document.segments,
    });
    const savedDocument: SavedDirtyDocument = {
      audioPath,
      csvPath: result.csvPath,
      annotationPath: result.annotationPath,
      stem: document.stem,
    };

    savedDocuments.push(savedDocument);
    await onSaved?.(savedDocument);
  }

  return savedDocuments;
}
