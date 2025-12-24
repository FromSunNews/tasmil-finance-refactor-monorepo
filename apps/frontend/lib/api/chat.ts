import { apiClient } from "./client";
import type { ChatMessage, PostChatRequestBody } from "@repo/api";

export const chatApi = {
  async createChat(body: PostChatRequestBody): Promise<ReadableStream<Uint8Array>> {
    return apiClient.stream("/api/chat", body);
  },

  async getChat(id: string) {
    return apiClient.get(`/api/chat/${id}`);
  },

  async getStream(chatId: string): Promise<ReadableStream<Uint8Array> | null> {
    try {
      return apiClient.stream(`/api/chat/${chatId}/stream`, undefined);
    } catch (error) {
      // Stream might not be available (returned null from backend)
      return null;
    }
  },

  async deleteChat(id: string) {
    return apiClient.delete(`/api/chat?id=${id}`);
  },

  async getHistory(limit: number = 10, startingAfter?: string, endingBefore?: string) {
    const params = new URLSearchParams({ limit: limit.toString() });
    if (startingAfter) params.append("starting_after", startingAfter);
    if (endingBefore) params.append("ending_before", endingBefore);
    return apiClient.get(`/api/history?${params.toString()}`);
  },

  async deleteAllHistory() {
    return apiClient.delete("/api/history");
  },
};

