import { createPrismaClient } from "@rack/database";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { catalog } from "./mcp/catalog.js";

const env = loadEnv();
const db = createPrismaClient(env.databaseUrl);
const app = await buildApp({ env, db, catalog });

app.addHook("onClose", async () => {
  await db.$disconnect();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: env.port, host: env.host });
  app.log.info(
    `MCP Accès ready at ${env.baseUrl} (mcps: ${app.registry.definitions.map((m) => m.slug).join(", ")})`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
