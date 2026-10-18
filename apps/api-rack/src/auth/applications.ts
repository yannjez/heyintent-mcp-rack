import type { Db } from "@rack/database";

export async function canAccessApplication(db: Db, clientId: string, userId: string) {
  const [client, user] = await Promise.all([
    db.oauthClient.findUnique({
      where: { clientId },
      include: {
        applicationAccesses: { where: { userId } },
        applicationGroups: {
          where: { group: { users: { some: { userId } } } },
        },
      },
    }),
    db.user.findUnique({ where: { id: userId }, select: { banned: true } }),
  ]);
  if (!client || client.disabled || !user || user.banned) return false;
  const override = client.applicationAccesses[0];
  if (override) return override.allowed;
  return !client.accessRestricted || client.applicationGroups.length > 0;
}
