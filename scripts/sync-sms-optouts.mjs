// Run with: node scripts/sync-sms-optouts.mjs
// Reads env from .env.local via --env-file flag or dotenv

import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local manually
const envPath = resolve(process.cwd(), ".env.local");
const envLines = readFileSync(envPath, "utf-8").split("\n");
for (const line of envLines) {
  const [key, ...rest] = line.split("=");
  if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
}

const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_IN = new Set(["START", "UNSTOP", "YES"]);

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
const messages = await client.messages.list({ to: twilioPhone });

const optOutPhones = new Set();
const optInPhones = new Set();

for (const msg of messages) {
  const keyword = (msg.body || "").trim().toUpperCase().split(/\s/)[0];
  const digits = (msg.from || "").replace(/\D/g, "").slice(-10);
  if (!digits) continue;
  if (OPT_OUT.has(keyword)) { optOutPhones.add(digits); optInPhones.delete(digits); }
  else if (OPT_IN.has(keyword)) { optInPhones.add(digits); optOutPhones.delete(digits); }
}

const [{ data: profiles }, { data: regs }] = await Promise.all([
  supabase.from("profiles").select("id, email, phone, sms_consent"),
  supabase.from("registrations").select("id, email, phone, sms_consent"),
]);

let profilesUpdated = 0;
for (const p of (profiles || [])) {
  if (!p.phone) continue;
  const digits = p.phone.replace(/\D/g, "").slice(-10);
  if (optOutPhones.has(digits) && p.sms_consent !== false) {
    await supabase.from("profiles").update({ sms_consent: false, updated_at: new Date().toISOString() }).eq("id", p.id);
    profilesUpdated++;
  } else if (optInPhones.has(digits) && p.sms_consent === false) {
    await supabase.from("profiles").update({ sms_consent: true, updated_at: new Date().toISOString() }).eq("id", p.id);
    profilesUpdated++;
  }
}

const optOutRegIds = [];
const optInRegIds = [];
for (const r of (regs || [])) {
  if (!r.phone) continue;
  const digits = r.phone.replace(/\D/g, "").slice(-10);
  if (optOutPhones.has(digits) && r.sms_consent !== false) optOutRegIds.push(r.id);
  else if (optInPhones.has(digits) && r.sms_consent === false) optInRegIds.push(r.id);
}

if (optOutRegIds.length > 0) await supabase.from("registrations").update({ sms_consent: false }).in("id", optOutRegIds);
if (optInRegIds.length > 0) await supabase.from("registrations").update({ sms_consent: true }).in("id", optInRegIds);

const regsUpdated = optOutRegIds.length + optInRegIds.length;
console.log(`Opt-outs: ${optOutPhones.size}, Opt-ins: ${optInPhones.size}`);
console.log(`Updated ${profilesUpdated} profile(s), ${regsUpdated} registration(s)`);
