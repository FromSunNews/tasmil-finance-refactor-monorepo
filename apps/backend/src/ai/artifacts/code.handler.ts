import { streamObject } from "ai";
import { z } from "zod";
import { codePrompt, updateDocumentPrompt } from "../prompts";
import { createDocumentHandler } from "./server";
import type { AiService } from "../ai.service";

export function createCodeDocumentHandler(aiService: AiService) {
  return createDocumentHandler<"code">({
    kind: "code",
    onCreateDocument: async ({ title, dataStream }) => {
      let draftContent = "";

      const { fullStream } = streamObject({
        model: aiService.getArtifactModel(),
        system: codePrompt,
        prompt: title,
        schema: z.object({
          code: z.string(),
        }),
      });

      for await (const delta of fullStream) {
        const { type } = delta;

        if (type === "object") {
          const { object } = delta;
          const { code } = object;

          if (code) {
            dataStream.write({
              type: "data-codeDelta",
              data: code ?? "",
              transient: true,
            });

            draftContent = code;
          }
        }
      }

      return draftContent;
    },
    onUpdateDocument: async ({ document, description, dataStream }) => {
      let draftContent = "";

      const { fullStream } = streamObject({
        model: aiService.getArtifactModel(),
        system: updateDocumentPrompt(document.content, "code"),
        prompt: description,
        schema: z.object({
          code: z.string(),
        }),
      });

      for await (const delta of fullStream) {
        const { type } = delta;

        if (type === "object") {
          const { object } = delta;
          const { code } = object;

          if (code) {
            dataStream.write({
              type: "data-codeDelta",
              data: code ?? "",
              transient: true,
            });

            draftContent = code;
          }
        }
      }

      return draftContent;
    },
  });
}

