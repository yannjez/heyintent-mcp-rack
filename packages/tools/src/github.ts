import { Octokit } from "@octokit/rest";
import type { GithubPushInput, GithubPushResult, GithubService } from "@rack/mcp-kit";

/** The subset of the GitHub Git Data API used by pushFiles, for injection in tests. */
export interface GitApi {
  getRef(p: { owner: string; repo: string; ref: string }): Promise<{ sha: string }>;
  createRef(p: { owner: string; repo: string; ref: string; sha: string }): Promise<void>;
  getCommit(p: {
    owner: string;
    repo: string;
    sha: string;
  }): Promise<{ treeSha: string }>;
  createBlob(p: {
    owner: string;
    repo: string;
    content: string;
    encoding: "utf-8" | "base64";
  }): Promise<{ sha: string }>;
  createTree(p: {
    owner: string;
    repo: string;
    baseTree: string;
    tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }>;
  }): Promise<{ sha: string }>;
  createCommit(p: {
    owner: string;
    repo: string;
    message: string;
    tree: string;
    parents: string[];
  }): Promise<{ sha: string; url: string }>;
  updateRef(p: { owner: string; repo: string; ref: string; sha: string }): Promise<void>;
}

export function octokitGitApi(token: string): GitApi {
  if (!token) throw new Error("GITHUB_TOKEN is not configured");
  const octokit = new Octokit({ auth: token });
  return {
    async getRef({ owner, repo, ref }) {
      const { data } = await octokit.rest.git.getRef({ owner, repo, ref });
      return { sha: data.object.sha };
    },
    async createRef({ owner, repo, ref, sha }) {
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/${ref}`, sha });
    },
    async getCommit({ owner, repo, sha }) {
      const { data } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: sha });
      return { treeSha: data.tree.sha };
    },
    async createBlob({ owner, repo, content, encoding }) {
      const { data } = await octokit.rest.git.createBlob({
        owner,
        repo,
        content,
        encoding,
      });
      return { sha: data.sha };
    },
    async createTree({ owner, repo, baseTree, tree }) {
      const { data } = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: baseTree,
        tree,
      });
      return { sha: data.sha };
    },
    async createCommit({ owner, repo, message, tree, parents }) {
      const { data } = await octokit.rest.git.createCommit({
        owner,
        repo,
        message,
        tree,
        parents,
      });
      return { sha: data.sha, url: data.html_url };
    },
    async updateRef({ owner, repo, ref, sha }) {
      await octokit.rest.git.updateRef({ owner, repo, ref, sha });
    },
  };
}

const PATH = /^(?!\/)(?!.*\.\.)[^\0]{1,500}$/;

export function createGithubService(git: GitApi): GithubService {
  return {
    async pushFiles(input: GithubPushInput): Promise<GithubPushResult> {
      if (input.files.length === 0) throw new Error("No files to push");
      for (const file of input.files) {
        if (!PATH.test(file.path)) throw new Error(`Invalid file path: ${file.path}`);
      }
      const { owner, repo, branch } = input;
      const ref = `heads/${branch}`;

      let headSha: string;
      try {
        headSha = (await git.getRef({ owner, repo, ref })).sha;
      } catch (error) {
        if (!input.baseBranch) throw error;
        headSha = (await git.getRef({ owner, repo, ref: `heads/${input.baseBranch}` }))
          .sha;
        await git.createRef({ owner, repo, ref, sha: headSha });
      }

      const { treeSha } = await git.getCommit({ owner, repo, sha: headSha });
      const tree = await Promise.all(
        input.files.map(async (file) => {
          const blob = await git.createBlob({
            owner,
            repo,
            content: file.content,
            encoding: file.encoding ?? "utf-8",
          });
          return {
            path: file.path,
            mode: "100644" as const,
            type: "blob" as const,
            sha: blob.sha,
          };
        }),
      );
      const newTree = await git.createTree({ owner, repo, baseTree: treeSha, tree });
      const commit = await git.createCommit({
        owner,
        repo,
        message: input.message,
        tree: newTree.sha,
        parents: [headSha],
      });
      await git.updateRef({ owner, repo, ref, sha: commit.sha });
      return { commitSha: commit.sha, commitUrl: commit.url, branch };
    },
  };
}
