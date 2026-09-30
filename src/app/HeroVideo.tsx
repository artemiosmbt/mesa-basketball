"use client";

import { useEffect, useRef, useState } from "react";

// The hero loop is a background: it must never hold the page hostage.
//
// What was happening: the home page has a mobile hero and a desktop hero,
// each with its own <HeroVideo>, so BOTH videos downloaded on every visit
// (the hidden one too — display:none does not stop a <video preload="auto">
// from fetching), and the file was the whole 88-second reel at 23 MB. A
// visitor pulled ~45 MB before the browser got round to the schedule data,
// the admin bundle or a tab click; on a slow connection the hero took a
// minute and every link felt dead until it finished.
//
// Now: the poster paints immediately (a plain <img>, so it is on screen
// before any script runs); only the variant that matches the viewport
// mounts a <video>; and the video's src is attached after the window's
// `load` event, so everything the page actually needs — scripts, data,
// the next route's prefetch — goes first. The file itself is a 12-second
// 540p loop (6.7 MB) instead of the full reel.
//
// `autoPlay` alone doesn't reliably autoplay everywhere a link to this site
// gets opened — in-app browsers (Instagram/Facebook/Messenger webviews in
// particular) sometimes ignore the declarative attribute on first paint and
// fall back to showing their own play button. Explicitly calling .play()
// once the source is attached, and again if the tab/webview regains
// visibility, recovers most of those cases. If the browser still refuses
// (e.g. iOS Reduce Motion), the poster stays — the correct fallback.
const SRC = "/videos/hero.mp4";
const POSTER = "/videos/hero-poster.jpg";
const DESKTOP = "(min-width: 768px)";   // Tailwind's md breakpoint, the same one page.tsx switches layouts on

export default function HeroVideo({ className, variant }: { className: string; variant: "mobile" | "desktop" }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);   // this variant is the one on screen
  const [ready, setReady] = useState(false);     // the page has finished loading; the video may fetch now

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const update = () => setActive(variant === "desktop" ? mq.matches : !mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [variant]);

  useEffect(() => {
    // (deferred a tick rather than set synchronously inside the effect —
    // the lint rule is right that a sync setState here cascades renders)
    if (document.readyState === "complete") { const id = setTimeout(() => setReady(true), 0); return () => clearTimeout(id); }
    const onLoad = () => setReady(true);
    window.addEventListener("load", onLoad);
    return () => window.removeEventListener("load", onLoad);
  }, []);

  useEffect(() => {
    if (!active || !ready) return;
    const video = videoRef.current;
    if (!video) return;
    const tryPlay = () => { video.play().catch(() => {}); };
    tryPlay();
    document.addEventListener("visibilitychange", tryPlay);
    return () => document.removeEventListener("visibilitychange", tryPlay);
  }, [active, ready]);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a hero background, full-bleed, no layout to compute */}
      <img src={POSTER} alt="" aria-hidden="true" className={className} />
      {active && ready && (
        <video
          ref={videoRef}
          src={SRC}
          poster={POSTER}
          autoPlay
          muted
          loop
          playsInline
          disablePictureInPicture
          preload="auto"
          className={className}
        />
      )}
    </>
  );
}
