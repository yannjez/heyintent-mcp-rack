import type { McpServer } from "@modelcontextprotocol/server";

export const CAPABILITIES = ["llm", "image", "github", "data"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** Access level on an MCP: "write" implies "read". */
export const ACCESS_LEVELS = ["read", "write"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export function isAccess(value: string): value is Access {
  return (ACCESS_LEVELS as readonly string[]).includes(value);
}

/** The lower of two access levels (null when either side denies). */
export function minAccess(a: Access | null, b: Access | null): Access | null {
  if (!a || !b) return null;
  return a === "write" && b === "write" ? "write" : "read";
}

/** The higher of two access levels (null when both sides deny). */
export function maxAccess(a: Access | null, b: Access | null): Access | null {
  if (a === "write" || b === "write") return "write";
  return a ?? b;
}

/** User typology, set by an admin. */
export const USER_KINDS = ["internal", "external", "client"] as const;
export type UserKind = (typeof USER_KINDS)[number];

export function isUserKind(value: string): value is UserKind {
  return (USER_KINDS as readonly string[]).includes(value);
}

/** Who is calling an MCP, and what the credential allows. */
export interface Identity {
  userId: string;
  email?: string;
  via: "apikey" | "oauth" | "session";
  keyId?: string;
  clientId?: string;
  grants: {
    /** Access per MCP slug the credential may use; "*" = every MCP, at the user's level. */
    mcps: "*" | Record<string, Access>;
    /** Capabilities the credential may use; "*" = every capability of the MCP. */
    caps: "*" | Capability[];
  };
}

export interface McpMeta {
  id: string;
  slug: string;
  name: string;
  version: string;
  /** Capabilities effectively available for this request. */
  capabilities: Capability[];
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Tool services provided by the rack to every MCP.
// ---------------------------------------------------------------------------

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteInput {
  messages: LlmMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmCompleteResult {
  text: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; cost?: number };
}

export interface LlmService {
  complete(input: LlmCompleteInput): Promise<LlmCompleteResult>;
  /** Models the rack allows, or [] when unrestricted. */
  allowedModels(): string[];
}

export interface ImageGenerateInput {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  n?: number;
}

export interface GeneratedImage {
  base64: string;
  mimeType: string;
}

export interface ImageService {
  generate(
    input: ImageGenerateInput,
  ): Promise<{ images: GeneratedImage[]; cost?: number }>;
}

export interface GithubFile {
  path: string;
  /** UTF-8 text content, or base64 when `encoding` is "base64". */
  content: string;
  encoding?: "utf-8" | "base64";
}

export interface GithubPushInput {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: GithubFile[];
  /** Create the branch from this ref when it does not exist yet. */
  baseBranch?: string;
}

export interface GithubPushResult {
  commitSha: string;
  commitUrl: string;
  branch: string;
}

export interface GithubService {
  pushFiles(input: GithubPushInput): Promise<GithubPushResult>;
}

export interface DataEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface DataStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string): Promise<DataEntry[]>;
}

export interface DataService extends DataStore {
  /** Shared across every user of the MCP. */
  global: DataStore;
}

export interface ToolServices {
  llm: LlmService;
  image: ImageService;
  github: GithubService;
  data: DataService;
}

// ---------------------------------------------------------------------------
// MCP definition.
// ---------------------------------------------------------------------------

/**
 * A connection parameter the MCP reads from the rack's environment
 * (connection string, API URL, token…). The rack resolves `env` at startup
 * and exposes the value under `key` in `ctx.settings`; the admin UI only
 * shows whether the variable is set, never its value.
 */
export interface McpSettingSpec {
  key: string;
  /** Environment variable name, e.g. "SITE_PUBLIC_API_URL". */
  env: string;
  label: string;
  description?: string;
  /** Example value shown in the admin UI and the docs. */
  example?: string;
}

export interface McpContext {
  mcp: McpMeta;
  identity: Identity;
  /** Effective access for this request: write tools are hidden when "read". */
  access: Access;
  /** Connection parameters resolved from the environment, "" when unset. */
  settings: Record<string, string>;
  tools: ToolServices;
  log: Logger;
}

/** Catalog entry for a tool, derived from the package without a live session. */
export interface McpToolInfo {
  name: string;
  title: string;
  description: string;
  /** Tools without `readOnlyHint: true` need write access. */
  write: boolean;
}

export interface McpDefinition {
  slug: string;
  name: string;
  version: string;
  description: string;
  /** Short family label shown in the UI (e.g. "Site web"). */
  category?: string;
  capabilities: Capability[];
  settings?: McpSettingSpec[];
  register(server: McpServer, ctx: McpContext): void | Promise<void>;
}
