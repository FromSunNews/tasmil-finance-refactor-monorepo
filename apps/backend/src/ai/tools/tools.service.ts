import { Injectable } from "@nestjs/common";
import { tool, type UIMessageStreamWriter, Output, streamText } from "ai";
import { z } from "zod";
import type { ChatMessage } from "@repo/api";
import type { JwtPayload } from "../../auth/auth.service";
import {
  getDocumentById,
  saveDocument,
  saveSuggestions,
  type Suggestion,
} from "@repo/db";
import { generateUUID } from "@repo/db";
import { AiService } from "../ai.service";
import { createDocumentHandlers, type ArtifactKind } from "../artifacts";

@Injectable()
export class ToolsService {
  private documentHandlers: ReturnType<typeof createDocumentHandlers>;

  constructor(private aiService: AiService) {
    this.documentHandlers = createDocumentHandlers(aiService);
  }

  getWeather() {
    return tool({
      description:
        "Get the current weather at a location. You can provide either coordinates or a city name.",
      inputSchema: z.object({
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        city: z
          .string()
          .describe("City name (e.g., 'San Francisco', 'New York', 'London')")
          .optional(),
      }),
      needsApproval: true,
      execute: async (input) => {
        let latitude: number;
        let longitude: number;

        if (input.city) {
          const coords = await this.geocodeCity(input.city);
          if (!coords) {
            return {
              error: `Could not find coordinates for "${input.city}". Please check the city name.`,
            };
          }
          latitude = coords.latitude;
          longitude = coords.longitude;
        } else if (input.latitude !== undefined && input.longitude !== undefined) {
          latitude = input.latitude;
          longitude = input.longitude;
        } else {
          return {
            error:
              "Please provide either a city name or both latitude and longitude coordinates.",
          };
        }

        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m&hourly=temperature_2m&daily=sunrise,sunset&timezone=auto`
        );

        const weatherData = await response.json();

        if ("city" in input) {
          weatherData.cityName = input.city;
        }

        return weatherData;
      },
    });
  }

  createDocument(
    session: JwtPayload,
    dataStream: UIMessageStreamWriter<ChatMessage>
  ) {
    return tool({
      description:
        "Create a document for a writing or content creation activities. This tool will call other functions that will generate the contents of the document based on the title and kind.",
      inputSchema: z.object({
        title: z.string(),
        kind: z.enum(["text", "code", "image", "sheet"]),
      }),
      execute: async ({ title, kind }) => {
        const id = generateUUID();

        dataStream.write({
          type: "data-kind",
          data: kind,
          transient: true,
        });

        dataStream.write({
          type: "data-id",
          data: id,
          transient: true,
        });

        dataStream.write({
          type: "data-title",
          data: title,
          transient: true,
        });

        dataStream.write({
          type: "data-clear",
          data: null,
          transient: true,
        });

        // Find and call the appropriate document handler
        const documentHandler = this.documentHandlers.find(
          (handler) => handler.kind === kind
        );

        if (!documentHandler) {
          throw new Error(`No document handler found for kind: ${kind}`);
        }

        // Call the document handler to generate content
        await documentHandler.onCreateDocument({
          id,
          title,
          dataStream,
          session,
        });

        dataStream.write({ type: "data-finish", data: null, transient: true });

        return {
          id,
          title,
          kind,
          content: "A document was created and is now visible to the user.",
        };
      },
    });
  }

  updateDocument(
    session: JwtPayload,
    dataStream: UIMessageStreamWriter<ChatMessage>
  ) {
    return tool({
      description: "Update a document with the given description.",
      inputSchema: z.object({
        id: z.string().describe("The ID of the document to update"),
        description: z
          .string()
          .describe("The description of changes that need to be made"),
      }),
      execute: async ({ id, description }) => {
        const document = await getDocumentById({ id });

        if (!document) {
          return {
            error: "Document not found",
          };
        }

        dataStream.write({
          type: "data-clear",
          data: null,
          transient: true,
        });

        // Find and call the appropriate document handler
        const documentHandler = this.documentHandlers.find(
          (handler) => handler.kind === document.kind
        );

        if (!documentHandler) {
          return {
            error: `No document handler found for kind: ${document.kind}`,
          };
        }

        // Call the document handler to update content
        await documentHandler.onUpdateDocument({
          document,
          description,
          dataStream,
          session,
        });

        dataStream.write({ type: "data-finish", data: null, transient: true });

        return {
          id,
          title: document.title,
          kind: document.kind,
          content: "The document has been updated successfully.",
        };
      },
    });
  }

  requestSuggestions(
    session: JwtPayload,
    dataStream: UIMessageStreamWriter<ChatMessage>
  ) {
    return tool({
      description:
        "Request writing suggestions for an existing document artifact. Only use this when the user explicitly asks to improve or get suggestions for a document they have already created. Never use for general questions.",
      inputSchema: z.object({
        documentId: z
          .string()
          .describe(
            "The UUID of an existing document artifact that was previously created with createDocument"
          ),
      }),
      execute: async ({ documentId }) => {
        const document = await getDocumentById({ id: documentId });

        if (!document || !document.content) {
          return {
            error: "Document not found",
          };
        }

        const suggestions: Omit<
          Suggestion,
          "userId" | "createdAt" | "documentCreatedAt"
        >[] = [];

        const { partialOutputStream } = streamText({
          model: this.aiService.getArtifactModel(),
          system:
            "You are a help writing assistant. Given a piece of writing, please offer suggestions to improve the piece of writing and describe the change. It is very important for the edits to contain full sentences instead of just words. Max 5 suggestions.",
          prompt: document.content,
          output: Output.array({
            element: z.object({
              originalSentence: z.string().describe("The original sentence"),
              suggestedSentence: z.string().describe("The suggested sentence"),
              description: z
                .string()
                .describe("The description of the suggestion"),
            }),
          }),
        });

        let processedCount = 0;
        for await (const partialOutput of partialOutputStream) {
          if (!partialOutput) {
            continue;
          }

          for (let i = processedCount; i < partialOutput.length; i++) {
            const element = partialOutput[i];
            if (
              !element?.originalSentence ||
              !element?.suggestedSentence ||
              !element?.description
            ) {
              continue;
            }

            const suggestion = {
              originalText: element.originalSentence,
              suggestedText: element.suggestedSentence,
              description: element.description,
              id: generateUUID(),
              documentId,
              isResolved: false,
            };

            dataStream.write({
              type: "data-suggestion",
              data: suggestion as Suggestion,
              transient: true,
            });

            suggestions.push(suggestion);
            processedCount++;
          }
        }

        if (session.id) {
          await saveSuggestions({
            suggestions: suggestions.map((suggestion) => ({
              ...suggestion,
              userId: session.id,
              createdAt: new Date(),
              documentCreatedAt: document.createdAt,
            })),
          });
        }

        return {
          id: documentId,
          title: document.title,
          kind: document.kind,
          message: "Suggestions have been added to the document",
        };
      },
    });
  }

  private async geocodeCity(
    city: string
  ): Promise<{ latitude: number; longitude: number } | null> {
    try {
      const response = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      if (!data.results || data.results.length === 0) {
        return null;
      }

      const result = data.results[0];
      return {
        latitude: result.latitude,
        longitude: result.longitude,
      };
    } catch {
      return null;
    }
  }
}

