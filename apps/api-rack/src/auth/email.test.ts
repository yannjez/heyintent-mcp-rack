import nodemailer from "nodemailer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env.js";
import { createOtpSender } from "./email.js";

vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));

const config = {
  BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "test",
  SMTP_PASSWORD: "test",
};

describe("OTP delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs the code in development even with SMTP configured", async () => {
    const log = vi.fn();
    const send = createOtpSender(loadEnv({ ...config, NODE_ENV: "development" }), log);

    await send("yann@heyintent.com", "123456");

    expect(log).toHaveBeenCalledWith("[Ressource Rack] OTP for yann@heyintent.com: 123456");
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it("uses console delivery when NODE_ENV is omitted", async () => {
    const log = vi.fn();
    await createOtpSender(loadEnv(config), log)("yann@heyintent.com", "123456");
    expect(log).toHaveBeenCalledOnce();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it("sends email without logging the code in production", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({
      sendMail,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const log = vi.fn();
    await createOtpSender(loadEnv({ ...config, NODE_ENV: "production" }), log)(
      "yann@heyintent.com",
      "123456",
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "yann@heyintent.com",
        subject: "123456 is your Ressource Rack code",
      }),
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects delivery without SMTP in production without logging the code", async () => {
    const log = vi.fn();
    const send = createOtpSender(
      loadEnv({ BETTER_AUTH_SECRET: config.BETTER_AUTH_SECRET, NODE_ENV: "production" }),
      log,
    );
    await expect(send("yann@heyintent.com", "123456")).rejects.toThrow(
      "SMTP is not configured",
    );
    expect(log).not.toHaveBeenCalled();
  });
});
