import "./env.js";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "./client.js";

const db = createPrismaClient();
const email = "yann@heyintent.com";

try {
  await db.user.upsert({
    where: { email },
    create: {
      id: randomUUID(),
      email,
      name: "Yann",
      role: "admin",
    },
    update: { role: "admin" },
  });
  console.log(`Admin account ready: ${email}`);
} finally {
  await db.$disconnect();
}
