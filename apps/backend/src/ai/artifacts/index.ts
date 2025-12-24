import type { DocumentHandler, ArtifactKind } from "./server";
import type { AiService } from "../ai.service";
import { createTextDocumentHandler } from "./text.handler";
import { createCodeDocumentHandler } from "./code.handler";
import { createSheetDocumentHandler } from "./sheet.handler";

export function createDocumentHandlers(
  aiService: AiService
): DocumentHandler[] {
  return [
    createTextDocumentHandler(aiService),
    createCodeDocumentHandler(aiService),
    createSheetDocumentHandler(aiService),
  ];
}

export type { DocumentHandler, ArtifactKind } from "./server";

