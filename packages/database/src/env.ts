import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Scripts run from packages/database (or dist/), but the .env lives at the repo root.
config({
  path: [
    ".env",
    fileURLToPath(new URL("../../../.env", import.meta.url)),
    fileURLToPath(new URL("../../../../.env", import.meta.url)),
  ],
  quiet: true,
});
