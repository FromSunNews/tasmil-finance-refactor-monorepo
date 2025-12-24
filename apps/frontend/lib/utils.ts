import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatISO } from "date-fns";
import type { DBMessage, Document } from "@repo/db";
import type { ChatMessage, CustomUIDataTypes, ChatTools } from "@repo/api";
import type { UIMessagePart } from "ai";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function convertToUIMessages(messages: DBMessage[]): ChatMessage[] {
  return messages.map((message) => {
    // Handle createdAt - it might be a string from API or a Date object
    let createdAt: Date;
    
    if (!message.createdAt) {
      // If createdAt is null/undefined, use current date
      createdAt = new Date();
    } else if (typeof message.createdAt === "string") {
      const parsedDate = new Date(message.createdAt);
      // Validate parsed date
      if (Number.isNaN(parsedDate.getTime())) {
        console.warn(`[convertToUIMessages] Invalid date string: ${message.createdAt}, using current date`);
        createdAt = new Date();
      } else {
        createdAt = parsedDate;
      }
    } else if (message.createdAt instanceof Date) {
      createdAt = message.createdAt;
    } else {
      // Try to convert unknown type to Date
      const parsedDate = new Date(message.createdAt as unknown as string | number);
      if (Number.isNaN(parsedDate.getTime())) {
        console.warn(`[convertToUIMessages] Invalid date value: ${message.createdAt}, using current date`);
        createdAt = new Date();
      } else {
        createdAt = parsedDate;
      }
    }

    return {
      id: message.id,
      role: message.role as "user" | "assistant" | "system",
      parts: message.parts as UIMessagePart<CustomUIDataTypes, ChatTools>[],
      metadata: {
        createdAt: formatISO(createdAt),
      },
    };
  });
}

export function getTextFromMessage(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

export const fetcher = async (url: string) => {
  // Use absolute URL if it's already absolute, otherwise prepend API base URL
  const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
  const absoluteUrl = url.startsWith("http") ? url : `${API_BASE_URL}${url}`;
  
  const response = await fetch(absoluteUrl, {
    credentials: "include",
  });

  if (!response.ok) {
    const { code, cause } = await response.json();
    const { ChatSDKError } = await import("@repo/api");
    throw new ChatSDKError(code, cause);
  }

  return response.json();
};

export async function fetchWithErrorHandlers(
  input: RequestInfo | URL,
  init?: RequestInit
) {
  try {
    // Ensure credentials are included for cookie-based auth
    const fetchInit: RequestInit = {
      ...init,
      credentials: "include",
    };

    const response = await fetch(input, fetchInit);

    if (!response.ok) {
      const { code, cause } = await response.json();
      const { ChatSDKError } = await import("@repo/api");
      throw new ChatSDKError(code, cause);
    }

    return response;
  } catch (error: unknown) {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      const { ChatSDKError } = await import("@repo/api");
      throw new ChatSDKError("offline:chat");
    }

    throw error;
  }
}

export function getDocumentTimestampByIndex(
  document: Document,
  index: number
): string {
  if (!document.versions || document.versions.length === 0) {
    return formatISO(document.createdAt);
  }

  const version = document.versions[index];
  if (!version) {
    return formatISO(document.createdAt);
  }

  return formatISO(version.createdAt);
}

export function sanitizeText(text: string): string {
  // Remove function call markers and escape HTML
  return text
    .replace(/<has_function_call>/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

