// Diamond Charter School, the new gym from November 2026. Families are used
// to every session being at St. Paul's, so every confirmation, reschedule and
// change notice for a session there calls out the new address (Artemios,
// 2026-10-28). Plain module (no server-only imports) so the booking page can
// share it too.

export const NEW_GYM = {
  name: "Diamond Charter School",
  address: "12 Westminster Rd, West Hempstead, NY 11552",
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=Diamond+Charter+School+12+Westminster+Rd+West+Hempstead+NY+11552",
};

// Any text naming it: the sheet's "Diamond Charter", the full name, or a
// session-details string that mentions it.
export function mentionsNewGym(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && t.toLowerCase().includes("diamond charter"));
}

// Appended to a client text when any of its sessions is there; "" otherwise.
export function newGymSmsNote(...texts: (string | null | undefined)[]): string {
  return mentionsNewGym(...texts)
    ? `\n⚠️ NEW LOCATION: ${NEW_GYM.name}, 12 Westminster Rd, West Hempstead — not St. Paul's.`
    : "";
}

// Put near the top of a client email when any of its sessions is there; "" otherwise.
export function newGymEmailNote(...texts: (string | null | undefined)[]): string {
  if (!mentionsNewGym(...texts)) return "";
  return `<div style="border: 2px solid #c4833e; background: #fdf8f6; border-radius: 8px; padding: 12px 14px; margin: 12px 0;">
    <p style="margin: 0 0 4px; font-weight: bold; color: #5c3d2e;">⚠️ NEW LOCATION — not St. Paul's</p>
    <p style="margin: 0;">This session is at <strong>${NEW_GYM.name}</strong>, <a href="${NEW_GYM.mapsUrl}">${NEW_GYM.address}</a> (about 3 minutes from St. Paul's). Not every session is at St. Paul's anymore, so check the location on each one.</p>
  </div>`;
}
