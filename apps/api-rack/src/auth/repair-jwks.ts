import { createPrismaClient } from "@rack/database";
import { symmetricDecrypt } from "better-auth/crypto";
import { loadEnv } from "../env.js";
import { createAuth } from "./auth.js";

const env = loadEnv();
if (env.nodeEnv !== "development") {
  throw new Error("JWKS repair is only available in development");
}
const databaseHost = env.databaseUrl ? new URL(env.databaseUrl).hostname : "";
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseHost)) {
  throw new Error("JWKS repair requires a local PostgreSQL database");
}

const db = createPrismaClient(env.databaseUrl);
try {
  const auth = createAuth(db, {
    baseUrl: env.baseUrl,
    secret: env.secret,
    isProduction: false,
    adminEmails: env.adminEmails,
    sendOtp: async () => {},
  });
  const { secretConfig } = await auth.$context;
  const keys = await db.jwks.findMany({ select: { id: true, privateKey: true } });
  const invalidIds: string[] = [];
  for (const key of keys) {
    try {
      await symmetricDecrypt({ key: secretConfig, data: JSON.parse(key.privateKey) });
    } catch {
      invalidIds.push(key.id);
    }
  }
  if (invalidIds.length > 0) {
    const result = await db.jwks.deleteMany({ where: { id: { in: invalidIds } } });
    console.log(`Removed ${result.count} unreadable local JWT key(s).`);
    console.log(
      "Better Auth will generate an encrypted replacement on the next request.",
    );
    console.log("MCP clients using tokens signed with the removed keys must reconnect.");
  } else {
    console.log("All local JWT keys can be decrypted; no changes needed.");
  }
} finally {
  await db.$disconnect();
}
