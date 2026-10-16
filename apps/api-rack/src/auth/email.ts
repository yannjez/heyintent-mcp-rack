import nodemailer from "nodemailer";
import type { Env } from "../env.js";

export type OtpSender = (email: string, otp: string) => Promise<void>;

export function createOtpSender(
  env: Env,
  log: (message: string) => void = console.info,
): OtpSender {
  if (env.nodeEnv === "development") {
    return async (email, otp) => {
      log(`[Ressource Rack] OTP for ${email}: ${otp}`);
    };
  }

  if (!env.smtp) {
    if (env.isProduction) {
      return async () => {
        throw new Error("SMTP is not configured");
      };
    }
    return async (email, otp) => {
      log(`[Ressource Rack] OTP for ${email}: ${otp}`);
    };
  }

  const transport = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    auth: { user: env.smtp.user, pass: env.smtp.password },
  });
  const from = env.smtp.from;

  return async (email, otp) => {
    await transport.sendMail({
      from,
      to: email,
      subject: `${otp} is your Ressource Rack code`,
      text: `Your sign-in code is ${otp}. It expires in 10 minutes. If you did not request it, you can ignore this email.`,
      html: `
        <div style="font-family:"Red Hat Text",Arial,sans-serif;color:#233839;max-width:520px;margin:auto;padding:32px">
          <p style="font-weight:700;font-size:18px">Intent · Ressource Rack</p>
          <h1 style="font-size:26px;margin-top:32px">Your sign-in code</h1>
          <p style="color:#416768">Enter this code to continue. It expires in 10 minutes.</p>
          <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#edf2f2;color:#194141;border-radius:6px;padding:20px;text-align:center;margin:28px 0">${otp}</div>
          <p style="font-size:13px;color:#8b8b98">If you did not request this email, you can safely ignore it.</p>
        </div>
      `,
    });
  };
}
