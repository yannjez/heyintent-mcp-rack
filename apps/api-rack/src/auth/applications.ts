import type { Db } from "@rack/database";

/**
 * Shared policy for sign-in and the personal application catalogue.
 * Three states: open to everyone, restricted to the linked groups, or disabled.
 */
export function applicationAllowed(client: {
  disabled: boolean | null;
  accessRestricted: boolean;
  applicationGroups: unknown[];
}) {
  if (client.disabled) return false;
  return !client.accessRestricted || client.applicationGroups.length > 0;
}

export async function canAccessApplication(db: Db, clientId: string, userId: string) {
  const [client, user] = await Promise.all([
    db.oauthClient.findUnique({
      where: { clientId },
      include: {
        applicationGroups: {
          where: { group: { users: { some: { userId } } } },
        },
      },
    }),
    db.user.findUnique({ where: { id: userId }, select: { banned: true } }),
  ]);
  if (!client || !user || user.banned) return false;
  return applicationAllowed(client);
}

/** Rack is the identity provider, not an application in its own catalogue. */
export function isRackApplication(
  client: { clientId: string; uri: string | null },
  baseUrl: string,
) {
  const origin = new URL(baseUrl).origin;
  return [client.clientId, client.uri].some((value) => {
    try {
      return !!value && new URL(value).origin === origin;
    } catch {
      return false;
    }
  });
}
