import { Injectable, HttpException, HttpStatus } from "@nestjs/common";
import { Observable, asyncScheduler } from "rxjs";
import { observeOn } from "rxjs/operators";
import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
  generateText,
} from "ai";
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from "resumable-stream";
import type { ChatMessage } from "@repo/api";
import { ChatSDKError } from "@repo/api";
import {
  createStreamId,
  deleteChatById,
  deleteMessagesByChatIdAfterTimestamp,
  getChatById,
  getMessageById,
  getMessageCountByUserId,
  getMessagesByChatId,
  getStreamIdsByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateChatVisibilityById,
  updateMessage,
  type DBMessage,
  generateUUID,
} from "@repo/db";
import { formatISO } from "date-fns";
import type { UIMessagePart } from "ai";
import type { CustomUIDataTypes, ChatTools } from "@repo/api";
import { AiService } from "../ai/ai.service";
import { ToolsService } from "../ai/tools/tools.service";
import { systemPrompt, titlePrompt } from "../ai/prompts";
import { entitlementsByUserType, type UserType } from "../ai/entitlements";
import type { JwtPayload } from "../auth/auth.service";

@Injectable()
export class ChatService {
  private streamContext: ResumableStreamContext | null = null;

  constructor(
    private aiService: AiService,
    private toolsService: ToolsService
  ) {
    this.initStreamContext();
  }

  private initStreamContext() {
    try {
      this.streamContext = createResumableStreamContext({
        waitUntil: async (promise: Promise<any>) => {
          await promise;
        },
      });
    } catch (error: any) {
      if (error.message?.includes("REDIS_URL")) {
        console.log(
          " > Resumable streams are disabled due to missing REDIS_URL"
        );
      } else {
        console.error(error);
      }
    }
  }

  private convertToUIMessages(messages: DBMessage[]): ChatMessage[] {
    return messages.map((message) => ({
      id: message.id,
      role: message.role as "user" | "assistant" | "system",
      parts: message.parts as UIMessagePart<CustomUIDataTypes, ChatTools>[],
      metadata: {
        createdAt: formatISO(message.createdAt),
      },
    }));
  }

  private getTextFromMessage(message: ChatMessage): string {
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { type: "text"; text: string }).text)
      .join("");
  }

  async generateTitleFromUserMessage(message: ChatMessage): Promise<string> {
    const { text: title } = await generateText({
      model: this.aiService.getTitleModel(),
      system: titlePrompt,
      prompt: this.getTextFromMessage(message),
    });
    return title;
  }

  async createChatStream(
    dto: {
      id: string;
      message?: ChatMessage;
      messages?: ChatMessage[];
      selectedChatModel: string;
      selectedVisibilityType: "public" | "private";
    },
    user: JwtPayload,
    requestHints: {
      latitude: number | null;
      longitude: number | null;
      city: string | null;
      country: string | null;
    }
  ): Promise<Observable<{ data: string }>> {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      dto;

    const userType: UserType = user.type as UserType;

    const messageCount = await getMessageCountByUserId({
      id: user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      throw new HttpException(
        new ChatSDKError("rate_limit:chat"),
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== user.id) {
        throw new HttpException(
          new ChatSDKError("forbidden:chat"),
          HttpStatus.FORBIDDEN
        );
      }
      if (!isToolApprovalFlow) {
        messagesFromDb = await getMessagesByChatId({ id });
      }
    } else if (message?.role === "user") {
      await saveChat({
        id,
        userId: user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });

      titlePromise = this.generateTitleFromUserMessage(message);
    }

    const uiMessages = isToolApprovalFlow
      ? (messages as ChatMessage[])
      : [...this.convertToUIMessages(messagesFromDb), message as ChatMessage];

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            chatId: id,
            id: message.id,
            role: "user",
            parts: message.parts,
            attachments: [],
            createdAt: new Date(),
          },
        ],
      });
    }

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    // Store result to access usage in onFinish
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let streamTextResult: any = null;

    const stream = createUIMessageStream({
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
      execute: async ({ writer: dataStream }) => {
        try {
          if (titlePromise) {
            void titlePromise.then((title) => {
              updateChatTitleById({ chatId: id, title });
              dataStream.write({ type: "data-chat-title", data: title });
            }).catch((error) => {
              console.error("Error generating title:", error);
            });
          }

          const isReasoningModel =
            selectedChatModel.includes("reasoning") ||
            selectedChatModel.includes("thinking");

          console.log(`[Chat] Starting stream for model: ${selectedChatModel}`);
          console.log(`[Chat] Messages count: ${uiMessages.length}`);

          const model = this.aiService.getLanguageModel(selectedChatModel);
          console.log(`[Chat] Model obtained:`, model?.modelId || "unknown");

          const result = streamText({
            model,
            system: systemPrompt({ selectedChatModel, requestHints }),
            messages: await convertToModelMessages(uiMessages),
            stopWhen: stepCountIs(5),
            experimental_activeTools: isReasoningModel
              ? []
              : [
                  "getWeather",
                  "createDocument",
                  "updateDocument",
                  "requestSuggestions",
                ],
            experimental_transform: isReasoningModel
              ? undefined
              : smoothStream({ chunking: "word" }),
            providerOptions: isReasoningModel
              ? {
                  anthropic: {
                    thinking: { type: "enabled", budgetTokens: 10_000 },
                  },
                }
              : undefined,
            tools: {
              getWeather: this.toolsService.getWeather(),
              createDocument: this.toolsService.createDocument(user, dataStream),
              updateDocument: this.toolsService.updateDocument(user, dataStream),
              requestSuggestions: this.toolsService.requestSuggestions(
                user,
                dataStream
              ),
            },
            experimental_telemetry: {
              isEnabled: process.env.NODE_ENV === "production",
              functionId: "stream-text",
            },
          });

          // Store result to access usage later
          streamTextResult = result;

          console.log(`[Chat] streamText result obtained`);
          void result.consumeStream();

          console.log(`[Chat] Merging UI message stream`);
          dataStream.merge(
            result.toUIMessageStream({
              sendReasoning: true,
            })
          );
        } catch (error) {
          console.error("[Chat] Error in execute function:", error);
          console.error("[Chat] Error stack:", error instanceof Error ? error.stack : "No stack");
          dataStream.write({
            type: "error",
            errorText: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      generateId: generateUUID,
      onFinish: async ({ messages: finishedMessages }) => {
        console.log("[Chat] onFinish called with messages:", finishedMessages.length);
        try {
          // Get usage from streamText result if available
          let usage = null;
          if (streamTextResult) {
            try {
              usage = await streamTextResult.usage;
            } catch {
              // Usage might not be available yet
            }
          }

          if (isToolApprovalFlow) {
            for (const finishedMsg of finishedMessages) {
              const existingMsg = uiMessages.find((m) => m.id === finishedMsg.id);
              if (existingMsg) {
                console.log("[Chat] Updating existing message:", finishedMsg.id);
                await updateMessage({
                  id: finishedMsg.id,
                  parts: finishedMsg.parts,
                });
              } else {
                console.log("[Chat] Saving new message:", finishedMsg.id);
                await saveMessages({
                  messages: [
                    {
                      id: finishedMsg.id,
                      role: finishedMsg.role,
                      parts: finishedMsg.parts,
                      createdAt: new Date(),
                      attachments: [],
                      chatId: id,
                    },
                  ],
                });
              }
            }
          } else if (finishedMessages.length > 0) {
            console.log("[Chat] Saving finished messages:", finishedMessages.length);
            await saveMessages({
              messages: finishedMessages.map((currentMessage) => ({
                id: currentMessage.id,
                role: currentMessage.role,
                parts: currentMessage.parts,
                createdAt: new Date(),
                attachments: [],
                chatId: id,
              })),
            });
            console.log("[Chat] Messages saved successfully");
            if (usage) {
              console.log("[Chat] Usage:", usage);
            }
          } else {
            console.log("[Chat] No finished messages to save");
          }
        } catch (error) {
          console.error("[Chat] Error saving messages in onFinish:", error);
          throw error;
        }
      },
      onError: (error) => {
        console.error("[Chat] Error in stream onError:", error);
        return "Oops, an error occurred!";
      },
    });

    // Convert to Observable for NestJS SSE
    // NestJS @Sse() decorator expects Observable<MessageEvent> where MessageEvent = { data: string }
    // JsonToSseTransformStream outputs "data: {json}\n\n" format
    // We need to extract the JSON from SSE format and transform finishReason if needed
    const observable = new Observable<{ data: string }>((subscriber) => {
      const sseStream = stream.pipeThrough(new JsonToSseTransformStream());
      const reader = sseStream.getReader();
      const decoder = new TextDecoder();
      let isCompleted = false;
      let buffer = "";

      const pump = async () => {
        try {
          let messageCount = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // Send any remaining buffered data
              if (buffer.trim()) {
                const jsonData = extractAndTransformJson(buffer.trim());
                if (jsonData) {
                  subscriber.next({ data: jsonData });
                }
              }
              isCompleted = true;
              await reader.releaseLock();
              subscriber.complete();
              break;
            }
            if (value) {
              // Decode chunk
              const chunk = typeof value === "string" ? value : decoder.decode(value, { stream: true });
              buffer += chunk;
              
              // Process complete SSE messages (ending with \n\n) immediately
              while (true) {
                const messageEndIndex = buffer.indexOf("\n\n");
                if (messageEndIndex === -1) {
                  // No complete message yet, keep buffering
                  break;
                }
                
                // Extract complete message
                const completeMessage = buffer.substring(0, messageEndIndex);
                buffer = buffer.substring(messageEndIndex + 2); // Remove message and \n\n
                
                if (completeMessage.trim()) {
                  const jsonData = extractAndTransformJson(completeMessage.trim());
                  if (jsonData) {
                    messageCount++;
                    subscriber.next({ data: jsonData });
                  }
                }
              }
            }
          }
        } catch (error) {
          console.error("[Chat] Error in pump:", error);
          console.error("[Chat] Error stack:", error instanceof Error ? error.stack : "No stack");
          if (!isCompleted) {
            isCompleted = true;
            try {
              await reader.releaseLock();
            } catch {
              // Ignore errors when releasing lock
            }
          }
          subscriber.error(error);
        }
      };

      void pump();

      // Return cleanup function
      return () => {
        if (!isCompleted) {
          isCompleted = true;
          try {
            reader.releaseLock();
          } catch {
            // Ignore errors when releasing lock during cleanup
          }
        }
      };
    });

    // Helper function to extract JSON from SSE format and transform finishReason
    function extractAndTransformJson(sseMessage: string): string | null {
      // Extract JSON from "data: {json}" format
      let jsonData = sseMessage.trim();
      if (jsonData.startsWith("data: ")) {
        jsonData = jsonData.substring(6); // Remove "data: "
      }
      
      // Parse and transform finishReason if needed
      try {
        const parsed = JSON.parse(jsonData);
        if (parsed.type === "finish" && parsed.finishReason) {
          // Transform finishReason from {unified: "stop"} to "stop"
          if (typeof parsed.finishReason === "object" && parsed.finishReason !== null) {
            if (parsed.finishReason.unified) {
              parsed.finishReason = parsed.finishReason.unified;
            } else {
              // If it's an object but doesn't have unified, try to get the first value
              const values = Object.values(parsed.finishReason as Record<string, unknown>);
              if (values.length > 0 && typeof values[0] === "string") {
                parsed.finishReason = values[0];
              }
            }
          }
        }
        return JSON.stringify(parsed);
      } catch {
        // If parsing fails, return null (invalid JSON)
        console.warn("[Chat] Failed to parse JSON:", jsonData.substring(0, 100));
        return null;
      }
    }
    
    // Use observeOn to ensure messages are sent asynchronously and not buffered
    return observable.pipe(observeOn(asyncScheduler));
  }

  async getChatWithMessages(chatId: string, userId: string) {
    const chat = await getChatById({ id: chatId });

    if (!chat) {
      throw new HttpException(
        new ChatSDKError("not_found:chat"),
        HttpStatus.NOT_FOUND
      );
    }

    if (chat.visibility === "private" && chat.userId !== userId) {
      throw new HttpException(
        new ChatSDKError("forbidden:chat"),
        HttpStatus.FORBIDDEN
      );
    }

    const messagesFromDb = await getMessagesByChatId({ id: chatId });
    const uiMessages = this.convertToUIMessages(messagesFromDb);

    return {
      chat,
      messages: uiMessages,
    };
  }

  async deleteChat(id: string, userId: string) {
    const chat = await getChatById({ id });

    if (!chat) {
      throw new HttpException(
        new ChatSDKError("not_found:chat"),
        HttpStatus.NOT_FOUND
      );
    }

    if (chat.userId !== userId) {
      throw new HttpException(
        new ChatSDKError("forbidden:chat"),
        HttpStatus.FORBIDDEN
      );
    }

    const deletedChat = await deleteChatById({ id });
    return deletedChat;
  }

  async getResumableStream(chatId: string, userId: string): Promise<Observable<string> | null> {
    if (!this.streamContext) {
      return null;
    }

    const chat = await getChatById({ id: chatId });
    if (!chat) {
      throw new HttpException(
        new ChatSDKError("not_found:chat"),
        HttpStatus.NOT_FOUND
      );
    }

    if (chat.visibility === "private" && chat.userId !== userId) {
      throw new HttpException(
        new ChatSDKError("forbidden:chat"),
        HttpStatus.FORBIDDEN
      );
    }

    const resumeRequestedAt = new Date();
    const streamIds = await getStreamIdsByChatId({ chatId });

    if (!streamIds.length) {
      throw new HttpException(
        new ChatSDKError("not_found:stream"),
        HttpStatus.NOT_FOUND
      );
    }

    const recentStreamId = streamIds.at(-1);

    if (!recentStreamId) {
      throw new HttpException(
        new ChatSDKError("not_found:stream"),
        HttpStatus.NOT_FOUND
      );
    }

    // Create empty stream for resumable stream fallback
    const emptyDataStream = createUIMessageStream<ChatMessage>({
      execute: () => {},
    });

    try {
      // Try to resume the stream
      const stream = await this.streamContext.resumableStream(
        recentStreamId,
        () => emptyDataStream.pipeThrough(new JsonToSseTransformStream())
      );

      // If stream exists, convert to Observable
      if (stream) {
        return new Observable<string>((subscriber) => {
          const reader = stream.getReader();

          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  subscriber.complete();
                  break;
                }
                if (value) {
                  // JsonToSseTransformStream outputs strings, not Uint8Array
                  const chunk = typeof value === "string" ? value : new TextDecoder().decode(value, { stream: true });
                  subscriber.next(chunk);
                }
              }
            } catch (error) {
              subscriber.error(error);
            }
          };

          pump();
        });
      }

      // Fallback: Stream already concluded, check if we should restore from database
      const messages = await getMessagesByChatId({ id: chatId });
      const mostRecentMessage = messages.at(-1);

      if (!mostRecentMessage || mostRecentMessage.role !== "assistant") {
        // Return empty stream as Observable
        return new Observable<string>((subscriber) => {
          const sseStream = emptyDataStream.pipeThrough(new JsonToSseTransformStream());
          const reader = sseStream.getReader();

          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  subscriber.complete();
                  break;
                }
                if (value) {
                  const chunk = typeof value === "string" ? value : new TextDecoder().decode(value, { stream: true });
                  subscriber.next(chunk);
                }
              }
            } catch (error) {
              subscriber.error(error);
            }
          };

          pump();
        });
      }

      const messageCreatedAt = new Date(mostRecentMessage.createdAt);
      const { differenceInSeconds } = await import("date-fns");

      // Only restore if message was created within 15 seconds
      if (differenceInSeconds(resumeRequestedAt, messageCreatedAt) > 15) {
        // Return empty stream as Observable
        return new Observable<string>((subscriber) => {
          const sseStream = emptyDataStream.pipeThrough(new JsonToSseTransformStream());
          const reader = sseStream.getReader();

          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  subscriber.complete();
                  break;
                }
                if (value) {
                  const chunk = typeof value === "string" ? value : new TextDecoder().decode(value, { stream: true });
                  subscriber.next(chunk);
                }
              }
            } catch (error) {
              subscriber.error(error);
            }
          };

          pump();
        });
      }

      // Restore stream with most recent message
      const restoredStream = createUIMessageStream<ChatMessage>({
        execute: ({ writer }) => {
          writer.write({
            type: "data-appendMessage",
            data: JSON.stringify(mostRecentMessage),
            transient: true,
          });
        },
      });

      return new Observable<string>((subscriber) => {
        const sseStream = restoredStream.pipeThrough(new JsonToSseTransformStream());
        const reader = sseStream.getReader();

        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                subscriber.complete();
                break;
              }
              if (value) {
                const chunk = typeof value === "string" ? value : new TextDecoder().decode(value, { stream: true });
                subscriber.next(chunk);
              }
            }
          } catch (error) {
            subscriber.error(error);
          }
        };

        pump();
      });
    } catch (error) {
      // If resumable stream fails, return null
      console.error("Failed to resume stream:", error);
      return null;
    }
  }

  async deleteTrailingMessages(messageId: string, userId: string) {
    const message = await getMessageById({ id: messageId });

    if (!message) {
      throw new HttpException(
        new ChatSDKError("not_found:chat"),
        HttpStatus.NOT_FOUND
      );
    }

    const chat = await getChatById({ id: message.chatId });

    if (!chat) {
      throw new HttpException(
        new ChatSDKError("not_found:chat"),
        HttpStatus.NOT_FOUND
      );
    }

    if (chat.userId !== userId) {
      throw new HttpException(
        new ChatSDKError("forbidden:chat"),
        HttpStatus.FORBIDDEN
      );
    }

    await deleteMessagesByChatIdAfterTimestamp({
      chatId: message.chatId,
      timestamp: message.createdAt,
    });
  }

  async updateChatVisibility(
    chatId: string,
    visibility: "private" | "public",
    userId: string
  ) {
    const chat = await getChatById({ id: chatId });

    if (!chat) {
      throw new HttpException(
        new ChatSDKError("not_found:chat"),
        HttpStatus.NOT_FOUND
      );
    }

    if (chat.userId !== userId) {
      throw new HttpException(
        new ChatSDKError("forbidden:chat"),
        HttpStatus.FORBIDDEN
      );
    }

    await updateChatVisibilityById({ chatId, visibility });
  }
}

