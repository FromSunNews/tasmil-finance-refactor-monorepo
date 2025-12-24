"use client";

import { defaultMarkdownSerializer } from "prosemirror-markdown";
import { DOMParser, type Node } from "prosemirror-model";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { renderToString } from "react-dom/server";

import { Response } from "@/components/elements/response";

import { documentSchema } from "./config";
import { createSuggestionWidget, type UISuggestion } from "./suggestions";

export const buildDocumentFromContent = (content: string): Node => {
  try {
    const parser = DOMParser.fromSchema(documentSchema);
    const stringFromMarkdown = renderToString(<Response>{content}</Response>);
    
    const tempContainer = document.createElement("div");
    tempContainer.innerHTML = stringFromMarkdown;
    
    // If Streamdown didn't render the content (only wrapper), parse markdown manually
    const hasContent = tempContainer.textContent && tempContainer.textContent.trim().length > 0;
    if (!hasContent || (tempContainer.textContent && tempContainer.textContent.trim().length < content.trim().length * 0.5)) {
      // Streamdown didn't render properly, parse markdown to HTML manually
      // Simple markdown to HTML conversion
      // First, normalize multiple newlines to single newline, then split
      const normalizedContent = content.replace(/\n{3,}/g, '\n\n');
      const htmlContent = normalizedContent
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/gim, '<em>$1</em>')
        .replace(/`([^`]+)`/gim, '<code>$1</code>')
        .split(/\n\n+/)
        .map(para => para.trim())
        .filter(para => para.length > 0) // Filter out empty paragraphs
        .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
        .join('');
      
      tempContainer.innerHTML = htmlContent || `<p>${content}</p>`;
    }
    
    const parsedDoc = parser.parse(tempContainer);
    
    // Remove empty paragraphs from the document
    const filteredContent: Node[] = [];
    parsedDoc.content.forEach((node) => {
      if (node.type.name === "paragraph") {
        // Only keep paragraphs that have text content
        if (node.textContent.trim().length > 0) {
          filteredContent.push(node);
        }
      } else {
        // Keep all non-paragraph nodes (headings, lists, etc.)
        filteredContent.push(node);
      }
    });
    
    // Create a new document with filtered content if we removed any empty paragraphs
    if (filteredContent.length !== parsedDoc.content.childCount) {
      // Ensure we have at least one node (ProseMirror requires at least one block node)
      const paragraphNode = documentSchema.nodes.paragraph;
      const nodesToUse = filteredContent.length > 0 
        ? filteredContent 
        : paragraphNode ? [paragraphNode.create()] : filteredContent;
      
      return parsedDoc.type.create(parsedDoc.attrs, nodesToUse);
    }
    
    return parsedDoc;
  } catch {
    // Fallback: create paragraph with content
    const parser = DOMParser.fromSchema(documentSchema);
    const tempContainer = document.createElement("div");
    tempContainer.innerHTML = `<p>${content}</p>`;
    return parser.parse(tempContainer);
  }
};

export const buildContentFromDocument = (document: Node) => {
  return defaultMarkdownSerializer.serialize(document);
};

export const createDecorations = (
  suggestions: UISuggestion[],
  view: EditorView
) => {
  const decorations: Decoration[] = [];

  for (const suggestion of suggestions) {
    const suggestionId = "id" in suggestion ? suggestion.id : String(suggestion.selectionStart);
    
    decorations.push(
      Decoration.inline(
        suggestion.selectionStart,
        suggestion.selectionEnd,
        {
          class: "suggestion-highlight",
        },
        {
          suggestionId,
          type: "highlight",
        }
      )
    );

    decorations.push(
      Decoration.widget(
        suggestion.selectionStart,
        (currentView) => {
          const { dom } = createSuggestionWidget(suggestion, currentView);
          return dom;
        },
        {
          suggestionId,
          type: "widget",
        }
      )
    );
  }

  return DecorationSet.create(view.state.doc, decorations);
};
