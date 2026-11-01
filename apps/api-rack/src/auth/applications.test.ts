import type { Db } from "@rack/database";
import { describe, expect, it, vi } from "vitest";
import { canAccessApplication, isRackApplication } from "./applications.js";

describe("application access policy", () => {
  function database(client: object | null, banned = false) {
    return {
      oauthClient: { findUnique: vi.fn().mockResolvedValue(client) },
      user: { findUnique: vi.fn().mockResolvedValue({ banned }) },
    } as unknown as Db;
  }
  const open = {
    disabled: false,
    accessRestricted: false,
    applicationGroups: [],
  };
  const restricted = { ...open, accessRestricted: true };

  it("preserves access to open applications and denies unknown applications", async () => {
    expect(await canAccessApplication(database(open), "app", "user")).toBe(true);
    expect(await canAccessApplication(database(null), "app", "user")).toBe(false);
  });
  it("requires a group assignment on restricted applications", async () => {
    expect(await canAccessApplication(database(restricted), "app", "user")).toBe(false);
    expect(
      await canAccessApplication(
        database({ ...restricted, applicationGroups: [{ groupId: "g" }] }),
        "app",
        "user",
      ),
    ).toBe(true);
  });
  it("blocks disabled applications and banned users despite group access", async () => {
    const granted = { ...restricted, applicationGroups: [{ groupId: "g" }] };
    expect(
      await canAccessApplication(database({ ...granted, disabled: true }), "app", "user"),
    ).toBe(false);
    expect(await canAccessApplication(database(granted, true), "app", "user")).toBe(
      false,
    );
    expect(await canAccessApplication(database(open, true), "app", "user")).toBe(false);
  });
});

describe("Rack is not a catalogue application", () => {
  const baseUrl = "https://mcp-rack.vps02.heyintent.com";
  it("hides same-origin client identifiers and application URLs", () => {
    expect(isRackApplication({ clientId: `${baseUrl}/`, uri: null }, baseUrl)).toBe(true);
    expect(
      isRackApplication(
        { clientId: `${baseUrl}/.well-known/client.json`, uri: null },
        baseUrl,
      ),
    ).toBe(true);
    expect(
      isRackApplication(
        { clientId: "native-client", uri: `${baseUrl}/?source=app` },
        baseUrl,
      ),
    ).toBe(true);
  });
  it("keeps external and native applications", () => {
    expect(
      isRackApplication(
        {
          clientId:
            "https://codefactory.vps02.heyintent.com/.well-known/oauth-client.json",
          uri: "https://codefactory.vps02.heyintent.com",
        },
        baseUrl,
      ),
    ).toBe(false);
    expect(isRackApplication({ clientId: "native-client", uri: null }, baseUrl)).toBe(
      false,
    );
    expect(
      isRackApplication(
        { clientId: "https://mcp-rack.vps02.heyintent.com.example.com", uri: null },
        baseUrl,
      ),
    ).toBe(false);
  });
});
