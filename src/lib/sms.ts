import twilio from "twilio";

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function sendSMS(phone: string, message: string): Promise<void> {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!accountSid || !authToken || !from) return;
    const client = twilio(accountSid, authToken);
    await client.messages.create({ body: message, from, to: formatPhone(phone) });
  } catch (err) {
    console.error("SMS failed:", err);
  }
}

// Sends to the admin's personal phone (ADMIN_PHONE_NUMBER env var). Silent no-op if not set.
export async function sendAdminSMS(message: string): Promise<void> {
  const phone = process.env.ADMIN_PHONE_NUMBER;
  if (!phone) return;
  await sendSMS(phone, message);
}
