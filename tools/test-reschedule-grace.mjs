/**
 * Checks on the "started before the cutoff" token.
 *
 *   npx tsx tools/test-reschedule-grace.mjs
 *
 * The rule: open your booking while it's still outside the 24-hour window and
 * you have ten minutes to finish the change without a late fee. Wait longer
 * than that — or try to fake it — and the fee applies as normal.
 */
process.env.CRON_SECRET = process.env.CRON_SECRET || "test-secret-for-grace-checks";

import { issueOnTimeToken, verifyOnTimeToken, ON_TIME_GRACE_MS } from "../src/lib/reschedule-grace.ts";

let failures = 0;
function check(name, got, want = true) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${got}, want ${want})`}`);
}

const REG = "reg-abc-123";
const now = Date.now();
const token = issueOnTimeToken(REG, now);

console.log("\nthe normal case");
check("finishing right away counts as on time", verifyOnTimeToken(token, REG, now + 1000));
check("finishing two minutes later still counts", verifyOnTimeToken(token, REG, now + 2 * 60 * 1000));
check("nine and a half minutes still counts", verifyOnTimeToken(token, REG, now + 9.5 * 60 * 1000));

console.log("\nthe ten-minute limit");
check("ten and a half minutes is too late", verifyOnTimeToken(token, REG, now + 10.5 * 60 * 1000), false);
check("an hour later is too late", verifyOnTimeToken(token, REG, now + 60 * 60 * 1000), false);
check("a day later is too late", verifyOnTimeToken(token, REG, now + 24 * 60 * 60 * 1000), false);
check("the window really is ten minutes", ON_TIME_GRACE_MS === 10 * 60 * 1000);

console.log("\nit can't be faked");
check("a made-up token fails", verifyOnTimeToken(`${now}.notarealsignature`, REG, now + 1000), false);
check("no token fails", verifyOnTimeToken(undefined, REG, now + 1000), false);
check("an empty token fails", verifyOnTimeToken("", REG, now + 1000), false);
check("someone else's token fails", verifyOnTimeToken(token, "reg-someone-else", now + 1000), false);
check(
  "moving the timestamp forward breaks the signature",
  verifyOnTimeToken(`${now + 9 * 60 * 1000}.${token.split(".")[1]}`, REG, now + 12 * 60 * 1000),
  false
);
check(
  "a token dated in the future is rejected",
  verifyOnTimeToken(issueOnTimeToken(REG, now + 10 * 60 * 1000), REG, now),
  false
);
check("garbage is rejected", verifyOnTimeToken("...", REG, now), false);

console.log("\nthe case this was built for");
{
  // 6:59pm, session tomorrow at 7pm: not late yet, so a token is issued.
  const openedAt = new Date("2026-09-24T18:59:00-04:00").getTime();
  const t = issueOnTimeToken(REG, openedAt);
  // They finish at 7:01pm — now inside the 24-hour window.
  const finishedAt = new Date("2026-09-24T19:01:00-04:00").getTime();
  check("started 6:59, finished 7:01 — no late fee", verifyOnTimeToken(t, REG, finishedAt));
  // Someone who opened it at 6:59 and came back at 9pm gets nothing.
  const cameBackAt = new Date("2026-09-24T21:00:00-04:00").getTime();
  check("started 6:59, finished 9:00 — fee applies", verifyOnTimeToken(t, REG, cameBackAt), false);
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
