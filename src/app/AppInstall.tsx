"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

type DeviceType = "ios" | "android" | "desktop" | null;

function detectDevice(): DeviceType {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/android/i.test(ua)) return "android";
  return "desktop";
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true) ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

const DISMISSED_KEY = "mesa_app_banner_dismissed";

const IOSSteps = () => (
  <ol className="space-y-3 text-sm text-brown-300">
    <li className="flex items-start gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-mesa-accent text-white text-xs font-bold flex items-center justify-center mt-0.5">1</span>
      <span>Open this site in <span className="text-white font-semibold">Safari</span> on your iPhone</span>
    </li>
    <li className="flex items-start gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-mesa-accent text-white text-xs font-bold flex items-center justify-center mt-0.5">2</span>
      <span>Tap the <span className="text-white font-semibold">three dots (•••)</span> in the bottom right corner of Safari</span>
    </li>
    <li className="flex items-start gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-mesa-accent text-white text-xs font-bold flex items-center justify-center mt-0.5">3</span>
      <span>Tap <span className="text-white font-semibold">&ldquo;Share&rdquo;</span></span>
    </li>
    <li className="flex items-start gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-mesa-accent text-white text-xs font-bold flex items-center justify-center mt-0.5">4</span>
      <span>Scroll down and tap <span className="text-white font-semibold">&ldquo;Add to Home Screen&rdquo;</span></span>
    </li>
    <li className="flex items-start gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-mesa-accent text-white text-xs font-bold flex items-center justify-center mt-0.5">5</span>
      <span>Tap <span className="text-white font-semibold">&ldquo;Add&rdquo;</span> — the Mesa icon will appear on your home screen</span>
    </li>
  </ol>
);

const AndroidSteps = () => (
  <ol className="space-y-3 text-sm text-brown-300">
    <li className="flex items-start gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-mesa-accent text-white text-xs font-bold flex items-center justify-center mt-0.5">1</span>
      <span>Open this site in <span className="text-white font-semibold">Chrome</span> on your Android phone</span>
    </li>
    <li className="flex items-start gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-mesa-accent text-white text-xs font-bold flex items-center justify-center mt-0.5">2</span>
      <span>Tap the <span className="text-white font-semibold">three-dot menu</span> in the top right corner</span>
    </li>
    <li className="flex items-start gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-mesa-accent text-white text-xs font-bold flex items-center justify-center mt-0.5">3</span>
      <span>Tap <span className="text-white font-semibold">&ldquo;Add to Home Screen&rdquo;</span></span>
    </li>
    <li className="flex items-start gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-mesa-accent text-white text-xs font-bold flex items-center justify-center mt-0.5">4</span>
      <span>Tap <span className="text-white font-semibold">&ldquo;Add&rdquo;</span> — the Mesa icon will appear on your home screen</span>
    </li>
  </ol>
);

// ─── Homepage Section ────────────────────────────────────────────────────────

export function AppInstallSection() {
  const [device, setDevice] = useState<DeviceType>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (isStandalone()) return; // already installed — hide everything
    setDevice(detectDevice());
    setHidden(false);
  }, []);

  if (hidden) return null;

  return (
    <section className="bg-brown-950 border-t border-brown-800 py-16 md:py-20">
      <div className="mx-auto max-w-4xl px-6">
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <div className="relative w-16 h-16 rounded-2xl overflow-hidden shadow-lg bg-white">
              <Image src="/logo.png" alt="Mesa Basketball" fill className="object-cover" />
            </div>
          </div>
          <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-2">Free — No App Store Needed</p>
          <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide">
            ADD MESA TO YOUR HOME SCREEN
          </h2>
          <p className="mt-3 text-brown-400 text-sm max-w-md mx-auto">
            Get instant access to sessions, bookings, and your schedule — right from your phone&apos;s home screen. No download required.
          </p>
        </div>

        {/* Mobile: show only relevant platform */}
        {(device === "ios") && (
          <div className="max-w-md mx-auto rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-7">
            <p className="font-[family-name:var(--font-fira-cond)] text-lg font-black tracking-wide text-white mb-5">iPhone / iPad</p>
            <IOSSteps />
          </div>
        )}

        {(device === "android") && (
          <div className="max-w-md mx-auto rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-7">
            <p className="font-[family-name:var(--font-fira-cond)] text-lg font-black tracking-wide text-white mb-5">Android</p>
            <AndroidSteps />
          </div>
        )}

        {/* Desktop: show both side by side */}
        {(device === "desktop") && (
          <div className="grid md:grid-cols-2 gap-6">
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-7">
              <p className="font-[family-name:var(--font-fira-cond)] text-lg font-black tracking-wide text-white mb-5">iPhone / iPad</p>
              <IOSSteps />
            </div>
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-7">
              <p className="font-[family-name:var(--font-fira-cond)] text-lg font-black tracking-wide text-white mb-5">Android</p>
              <AndroidSteps />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Sticky Mobile Banner ────────────────────────────────────────────────────

export function AppInstallBanner() {
  const [visible, setVisible] = useState(false);
  const [device, setDevice] = useState<DeviceType>(null);

  useEffect(() => {
    if (isStandalone()) return;
    if (localStorage.getItem(DISMISSED_KEY)) return;
    const d = detectDevice();
    if (d === "ios" || d === "android") {
      setDevice(d);
      setVisible(true);
    }
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-brown-900 border-t border-brown-700 px-4 py-3 flex items-center gap-3 shadow-2xl">
      <div className="relative w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 bg-white">
        <Image src="/logo.png" alt="Mesa Basketball" fill className="object-cover" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-semibold leading-tight">Add Mesa to your home screen</p>
        <p className="text-brown-400 text-xs mt-0.5">
          {device === "ios" ? "Tap Share → Add to Home Screen" : "Tap menu → Add to Home Screen"}
        </p>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="flex-shrink-0 text-brown-500 hover:text-white transition p-1"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
