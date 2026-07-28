import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const CANONICAL_HOST = "www.mesabasketballtraining.com";

export function middleware(request: NextRequest) {
  if (request.headers.get("host") === "mesa-basketball.vercel.app") {
    const url = request.nextUrl.clone();
    url.protocol = "https";
    url.host = CANONICAL_HOST;
    url.port = "";
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
