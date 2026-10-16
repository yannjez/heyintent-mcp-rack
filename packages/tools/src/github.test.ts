import { describe, expect, it, vi } from "vitest";
import { createGithubService, type GitApi } from "./github.js";

function fakeGit(overrides: Partial<GitApi> = {}): GitApi {
  return {
    getRef: vi.fn(async () => ({ sha: "head" })),
    createRef: vi.fn(async () => {}),
    getCommit: vi.fn(async () => ({ treeSha: "tree0" })),
    createBlob: vi.fn(async ({ content }) => ({ sha: `blob-${content}` })),
    createTree: vi.fn(async () => ({ sha: "tree1" })),
    createCommit: vi.fn(async () => ({
      sha: "c1",
      url: "https://github.com/o/r/commit/c1",
    })),
    updateRef: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("github service", () => {
  it("creates blobs, tree, commit and moves the branch", async () => {
    const git = fakeGit();
    const result = await createGithubService(git).pushFiles({
      owner: "o",
      repo: "r",
      branch: "main",
      message: "add",
      files: [{ path: "a.txt", content: "A" }],
    });
    expect(result).toEqual({
      commitSha: "c1",
      commitUrl: "https://github.com/o/r/commit/c1",
      branch: "main",
    });
    expect(git.createTree).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      baseTree: "tree0",
      tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: "blob-A" }],
    });
    expect(git.updateRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "heads/main",
      sha: "c1",
    });
  });

  it("creates the branch from baseBranch when missing", async () => {
    const getRef = vi
      .fn<GitApi["getRef"]>()
      .mockRejectedValueOnce(new Error("404"))
      .mockResolvedValueOnce({ sha: "base" });
    const git = fakeGit({ getRef });
    await createGithubService(git).pushFiles({
      owner: "o",
      repo: "r",
      branch: "feature",
      baseBranch: "main",
      message: "m",
      files: [{ path: "x", content: "y" }],
    });
    expect(git.createRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "heads/feature",
      sha: "base",
    });
  });

  it("rejects path traversal", async () => {
    await expect(
      createGithubService(fakeGit()).pushFiles({
        owner: "o",
        repo: "r",
        branch: "b",
        message: "m",
        files: [{ path: "../etc", content: "" }],
      }),
    ).rejects.toThrow(/Invalid file path/);
  });
});
