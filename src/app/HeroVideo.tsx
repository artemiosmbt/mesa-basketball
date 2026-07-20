"use client";

import { useEffect, useRef } from "react";

// `autoPlay` alone doesn't reliably autoplay everywhere a link to this site
// gets opened — in-app browsers (Instagram/Facebook/Messenger webviews in
// particular) sometimes ignore the declarative attribute on first paint and
// fall back to showing their own play button. Explicitly calling .play() on
// mount, and again if the tab/webview regains visibility mid-load, recovers
// most of those cases. If the browser still refuses (e.g. iOS Reduce Motion,
// which intentionally disables autoplay as an accessibility preference), the
// promise just rejects silently and the poster + native play control show —
// that's the correct, expected fallback, not a bug to work around.
export default function HeroVideo({ className }: { className: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tryPlay = () => {
      video.play().catch(() => {});
    };
    tryPlay();
    document.addEventListener("visibilitychange", tryPlay);
    return () => document.removeEventListener("visibilitychange", tryPlay);
  }, []);

  return (
    <video
      ref={videoRef}
      src="/videos/hero.mp4"
      poster="/videos/hero-poster.jpg"
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      className={className}
    />
  );
}
