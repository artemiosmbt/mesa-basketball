// Diamond Charter School, the new gym from November 2026. Families are used
// to every session being at St. Paul's, so a family's first booking there
// calls out the new address (see new-gym-server.ts for the email/text
// callout, and the booking page's popup). Plain module, no server-only
// imports.

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
