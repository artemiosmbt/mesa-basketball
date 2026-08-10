"use client";

import { useEffect, useRef } from "react";

// Same autoplay-retry approach as HeroVideo.tsx — `autoPlay` alone doesn't
// reliably kick in everywhere a link to this site gets opened (in-app
// browsers in particular), so we explicitly call .play() on mount and again
// if the tab/webview regains visibility mid-load.
export default function TrainerVideo({ src, className }: { src: string; className: string }) {
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
      src={src}
      autoPlay
      muted
      loop
      playsInline
      disablePictureInPicture
      preload="auto"
      className={className}
    />
  );
}
