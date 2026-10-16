import type { CallToolResult } from "@modelcontextprotocol/server";

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent:
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : { value },
  };
}

export function imageResult(
  base64: string,
  mimeType: string,
  caption?: string,
): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "image", data: base64, mimeType }];
  if (caption) content.unshift({ type: "text", text: caption });
  return { content };
}

export function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a tool body and turn thrown errors into `isError` results. */
export async function guarded(
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return errorResult(error);
  }
}
