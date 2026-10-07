import { createTransport, type Transporter } from "nodemailer";
import { config } from "./config";

let transport: Transporter | null = null;

/** Sends the one-time code. Without SMTP_URL (local development) the code is only printed to the server log. */
export async function sendCode(email: string, code: string): Promise<boolean> {
  if (!config.smtpUrl) {
    console.log(`[mail] (no SMTP configured) code for ${email}: ${code}`);
    return false;
  }
  transport ??= createTransport(config.smtpUrl);
  await transport.sendMail({
    from: config.mailFrom,
    to: email,
    subject: `Your Omo Ibadan code: ${code}`,
    text: `Your Omo Ibadan code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px"><h2 style="color:#6E3520;margin:0 0 8px">Omo Ibadan</h2><p>Your code is</p><p style="font-size:34px;letter-spacing:8px;font-weight:800;color:#1E1B3A;margin:8px 0">${code}</p><p style="color:#777">It expires in 10 minutes. If you did not ask for it, you can ignore this email.</p></div>`,
  });
  return true;
}
