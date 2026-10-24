// Used only by `auth generate` to emit the Prisma schema for the plugins in
// use. It never connects to a database: every model/method resolves empty.
import { createAuth } from "./auth.js";

const emptyModel = new Proxy(
  {},
  {
    get: (_target, method: string) => async () => (method === "findMany" ? [] : null),
  },
);
const fakePrisma = new Proxy({}, { get: () => emptyModel });

export const auth = createAuth(fakePrisma, {
  baseUrl: "http://localhost:3001",
  secret: "schema-generation-only-secret-0123456789abcdef",
  isProduction: false,
  adminEmails: [],
  sendOtp: async () => {},
});
