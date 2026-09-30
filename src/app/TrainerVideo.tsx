"use client";

import { useEffect, useRef, useState } from "react";

// A trainer's reel sits below the fold and can be big (Joe's is 36 MB).
// With `preload="auto"` and the src set at mount it downloaded the moment
// the page opened, in parallel with everything the page actually needed.
// Now the src is attached only when the player scrolls near the viewport
// (IntersectionObserver, one screen of margin), and it starts fetching
// only then.
//
// Same autoplay-retry approach as HeroVideo.tsx — `autoPlay` alone doesn't
// reliably kick in everywhere a link to this site gets opened (in-app
// browsers in particular), so we explicitly call .play() once the source is
// attached and again if the tab/webview regains visibility mid-load.
export default function TrainerVideo({ src, className }: { src: string; className: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!("IntersectionObserver" in window)) { const id = setTimeout(() => setNear(true), 0); return () => clearTimeout(id); }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { rootMargin: "100% 0px" });
    io.observe(video);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    const video = videoRef.current;
    if (!video) return;
    const tryPlay = () => { video.play().catch(() => {}); };
    tryPlay();
    document.addEventListener("visibilitychange", tryPlay);
    return () => document.removeEventListener("visibilitychange", tryPlay);
  }, [near]);

  return (
    <video
      ref={videoRef}
      src={near ? src : undefined}
      autoPlay
      muted
      loop
      playsInline
      disablePictureInPicture
      preload={near ? "auto" : "none"}
      className={className}
    />
  );
}
