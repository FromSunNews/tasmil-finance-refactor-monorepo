import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Chat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { DEFAULT_CHAT_MODEL } from "@/lib/constants";
import { convertToUIMessages } from "@/lib/utils";
import type { ChatMessage } from "@repo/api";

export default function Page(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <ChatPage params={props.params} />
    </Suspense>
  );
}

async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  
  const cookieStore = await cookies();
  const authToken = cookieStore.get("auth_token");
  const chatModelFromCookie = cookieStore.get("chat-model");
  
  let initialMessages: ChatMessage[] = [];
  let initialVisibilityType: "public" | "private" = "private";

  try {
    // Fetch chat and messages from backend API
    const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9337";
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    
    // Add auth token if available
    if (authToken?.value) {
      headers["Authorization"] = `Bearer ${authToken.value}`;
    }
    
    const response = await fetch(`${API_BASE_URL}/api/chat/${id}`, {
      credentials: "include",
      headers,
    });

    if (response.ok) {
      const data = await response.json();
      console.log("[ChatPage] Fetched chat data:", {
        chatId: id,
        hasChat: !!data.chat,
        messagesCount: data.messages?.length || 0,
        visibility: data.chat?.visibility,
      });
      initialMessages = convertToUIMessages(data.messages || []);
      initialVisibilityType = data.chat?.visibility || "private";
      console.log("[ChatPage] Converted messages:", initialMessages.length);
    } else if (response.status === 404) {
      console.log("[ChatPage] Chat not found, redirecting");
      redirect("/");
    } else {
      console.error("[ChatPage] Failed to fetch chat:", response.status, response.statusText);
    }
  } catch (error) {
    console.error("Error fetching chat:", error);
    // If fetch fails, continue with empty messages (new chat)
  }

  // Check if user has access to this chat
  // Note: In production, you'd want to check session user ID
  const isReadonly = false; // TODO: Check if current user is the owner

  return (
    <>
      <Chat
        autoResume={true}
        id={id}
        initialChatModel={chatModelFromCookie?.value || DEFAULT_CHAT_MODEL}
        initialMessages={initialMessages}
        initialVisibilityType={initialVisibilityType}
        isReadonly={isReadonly}
      />
      <DataStreamHandler />
    </>
  );
}

