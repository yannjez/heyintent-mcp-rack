import type { Db } from "@rack/database";
import {
  type Capability,
  CapabilityDeniedError,
  type DataService,
  type GithubService,
  type Identity,
  type ImageService,
  type LlmService,
  type Logger,
  type ToolServices,
} from "@rack/mcp-kit";
import { createDataService } from "./data.js";
import { createGithubService, type GitApi, octokitGitApi } from "./github.js";
import { createImageService } from "./image.js";
import { withToolCall } from "./journal.js";
import { createLlmService } from "./llm.js";
import type { FetchLike } from "./openrouter.js";

export interface ToolServicesConfig {
  openRouter: {
    apiKey: string;
    defaultModel: string;
    allowedModels: string[];
    imageModel: string;
    fetch?: FetchLike;
  };
  github: {
    token: string;
    /** Test seam: bypass Octokit. */
    gitApi?: GitApi;
  };
}

export interface ToolServicesInput {
  db: Db;
  config: ToolServicesConfig;
  mcpId: string;
  identity: Identity;
  capabilities: Capability[];
  log: Logger;
  /** Per-MCP GitHub token overriding the global one. */
  githubToken?: string;
}

function denied<T extends object>(capability: Capability, reason: string): T {
  return new Proxy({} as T, {
    get: () => () => {
      throw new CapabilityDeniedError(capability, reason);
    },
  });
}

export function createToolServices(input: ToolServicesInput): ToolServices {
  const { db, config, mcpId, identity, log } = input;
  const enabled = new Set(input.capabilities);
  const journal = { db, mcpId, identity, log };

  const llm: LlmService = enabled.has("llm")
    ? wrapLlm(
        createLlmService({
          apiKey: config.openRouter.apiKey,
          defaultModel: config.openRouter.defaultModel,
          allowedModels: config.openRouter.allowedModels,
          ...(config.openRouter.fetch ? { fetch: config.openRouter.fetch } : {}),
        }),
      )
    : denied<LlmService>("llm", "not available for this MCP or credential");

  const image: ImageService = enabled.has("image")
    ? wrapImage(
        createImageService({
          apiKey: config.openRouter.apiKey,
          defaultModel: config.openRouter.imageModel,
          ...(config.openRouter.fetch ? { fetch: config.openRouter.fetch } : {}),
        }),
      )
    : denied<ImageService>("image", "not available for this MCP or credential");

  const github: GithubService = enabled.has("github")
    ? wrapGithub(
        lazyGithub(() =>
          createGithubService(
            config.github.gitApi ??
              octokitGitApi(input.githubToken || config.github.token),
          ),
        ),
      )
    : denied<GithubService>("github", "not available for this MCP or credential");

  const data: DataService = enabled.has("data")
    ? createDataService(db, mcpId, identity.userId)
    : denied<DataService>("data", "not available for this MCP or credential");

  return { llm, image, github, data };

  function wrapLlm(service: LlmService): LlmService {
    return {
      allowedModels: () => service.allowedModels(),
      complete: (args) =>
        withToolCall(
          journal,
          "llm.complete",
          "llm",
          () => service.complete(args),
          (r) => r.usage?.cost,
        ),
    };
  }

  function wrapImage(service: ImageService): ImageService {
    return {
      generate: (args) =>
        withToolCall(
          journal,
          "image.generate",
          "image",
          () => service.generate(args),
          (r) => r.cost,
        ),
    };
  }

  /** Octokit needs a token: build it on first use so an unconfigured rack still serves other tools. */
  function lazyGithub(factory: () => GithubService): GithubService {
    let service: GithubService | undefined;
    return {
      pushFiles: (args) => (service ??= factory()).pushFiles(args),
    };
  }

  function wrapGithub(service: GithubService): GithubService {
    return {
      pushFiles: (args) =>
        withToolCall(journal, "github.pushFiles", "github", () =>
          service.pushFiles(args),
        ),
    };
  }
}
