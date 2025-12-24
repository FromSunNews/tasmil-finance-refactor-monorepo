"use server";

import { suggestionsApi } from "@/lib/api/suggestions";

export async function getSuggestions({ documentId }: { documentId: string }) {
  try {
    const suggestions = await suggestionsApi.getSuggestions(documentId);
    return suggestions ?? [];
  } catch (error) {
    console.error("Error fetching suggestions:", error);
    return [];
  }
}
