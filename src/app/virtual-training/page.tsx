"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import LandingNav from "../LandingNav";

const plans = [
  {
    name: "Monthly",
    price: "$30",
    period: "/ month",
    billing: "Billed monthly",
    perMonth: "$30 / mo",
    highlight: false,
    savings: null,
  },
  {
    name: "6-Month",
    price: "$120",
    period: "/ 6 months",
    billing: "Billed every 6 months",
    perMonth: "$20 / mo",
    highlight: false,
    savings: "Save $60",
  },
  {
    name: "Yearly",
    price: "$180",
    period: "/ year",
    billing: "Billed annually",
    perMonth: "$15 / mo",
    highlight: true,
    savings: "Best Value",
  },
];

const included = [
  "Full access to the entire workout library",
  "New content added every week",
  "Ball handling, shooting, footwork & more",
  "Workouts you can do anywhere, no gym required",
  "Beginner through advanced progressions",
  "All future content included — no extra charge",
];

export default function VirtualTrainingPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setStatus(res.ok ? "done" : "error");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      <LandingNav />

      {/* Hero */}
      <section className="relative overflow-hidden min-h-[60vh] md:min-h-[80vh] flex items-center">
        <Image
          src="/photos/virtual1.jpg"
          alt="Basketball training at St. John's"
          fill
          className="object-cover object-center"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-br from-mesa-dark/90 via-mesa-dark/70 to-brown-900/50" />
        <div className="absolute inset-0 bg-gradient-to-t from-mesa-dark via-transparent to-transparent" />
        <div className="relative mx-auto max-w-4xl px-6 py-32 text-center w-full">
          <p className="mb-4 text-xl font-semibold uppercase tracking-widest text-mesa-accent">
            Online Training
          </p>
          <h1 className="font-[family-name:var(--font-fira-cond)] text-6xl md:text-8xl font-black tracking-wide leading-none">
            TRAIN ON YOUR<br />OWN TIME.
          </h1>
          <p className="mt-6 max-w-xl mx-auto text-brown-300 text-lg leading-relaxed">
            A growing library of basketball workouts built by Artemios Gavalas — designed for players who want to put in the work outside of sessions. New content every week.
          </p>
          <div className="mt-5 inline-block rounded-full bg-mesa-accent/20 border border-mesa-accent/40 px-5 py-1.5 text-sm font-semibold text-mesa-accent">
            Coming Soon — Join the Waitlist
          </div>
          <div className="mt-5 max-w-md mx-auto">
            {status === "done" ? (
              <p className="text-white font-semibold text-lg">You&apos;re on the list! We&apos;ll be in touch.</p>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
                <input
                  type="email"
                  required
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-lg px-5 py-3.5 bg-white/90 text-mesa-dark placeholder-brown-500 font-medium text-sm w-full focus:outline-none focus:ring-2 focus:ring-mesa-accent"
                />
                <button
                  type="submit"
                  disabled={status === "loading"}
                  className="rounded-lg bg-mesa-accent px-7 py-3.5 font-bold text-white text-sm hover:bg-yellow-600 transition disabled:opacity-60 whitespace-nowrap"
                >
                  {status === "loading" ? "Joining..." : "Join Waitlist"}
                </button>
              </form>
            )}
            {status === "error" && (
              <p className="mt-2 text-brown-300 text-xs">Something went wrong — email us at artemios@mesabasketballtraining.com</p>
            )}
          </div>
        </div>
      </section>

      {/* What's Included */}
      <section className="bg-brown-950 border-t border-brown-800 py-16 md:py-24">
        <div className="mx-auto max-w-4xl px-6">
          <div className="text-center mb-10">
            <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-2">Everything in One Place</p>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide">WHAT YOU GET</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {included.map((item) => (
              <div key={item} className="flex items-start gap-3 rounded-xl border border-brown-700 bg-brown-900/40 px-5 py-4">
                <span className="text-mesa-accent mt-0.5 text-lg leading-none">◆</span>
                <span className="text-brown-200 text-sm leading-relaxed">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Photo divider */}
      <div className="relative h-56 md:h-[36rem] overflow-hidden">
        <Image
          src="/photos/virtual2.jpg"
          alt="Ball handling drill on court"
          fill
          className="object-cover object-[center_30%]"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-mesa-dark/80 via-mesa-dark/40 to-mesa-dark/80" />
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="font-[family-name:var(--font-fira-cond)] text-2xl md:text-5xl font-black tracking-widest text-white text-center px-6 drop-shadow-lg">
            EVERY WORKOUT.<span className="text-mesa-accent"> EVERY WEEK.</span>
          </p>
        </div>
      </div>

      {/* Pricing */}
      <section className="bg-mesa-dark border-t border-brown-800 py-16 md:py-24">
        <div className="mx-auto max-w-5xl px-6">
          <div className="text-center mb-12">
            <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-2">Simple Pricing</p>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide">CHOOSE YOUR PLAN</h2>
            <p className="mt-3 text-brown-400 text-sm">All plans include full access. Commit longer, pay less per month.</p>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`relative rounded-2xl border px-7 py-8 flex flex-col gap-4 ${
                  plan.highlight
                    ? "border-mesa-accent bg-brown-900/60 shadow-lg shadow-mesa-accent/10"
                    : "border-brown-700 bg-brown-900/30"
                }`}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-mesa-accent px-4 py-0.5 text-xs font-bold text-white uppercase tracking-wide whitespace-nowrap">
                    Best Value
                  </div>
                )}
                {plan.savings && !plan.highlight && (
                  <div className="absolute top-4 right-4 rounded-full bg-mesa-accent/20 border border-mesa-accent/40 px-2.5 py-0.5 text-xs font-semibold text-mesa-accent">
                    {plan.savings}
                  </div>
                )}
                <div>
                  <p className="text-sm font-semibold uppercase tracking-widest text-brown-400 mb-1">{plan.name}</p>
                  <div className="flex items-end gap-1">
                    <span className="font-[family-name:var(--font-fira-cond)] text-5xl font-black text-white">{plan.price}</span>
                    <span className="text-brown-400 text-sm mb-1.5">{plan.period}</span>
                  </div>
                  <p className="text-mesa-accent text-sm font-semibold mt-1">{plan.perMonth}</p>
                  <p className="text-brown-500 text-xs mt-0.5">{plan.billing}</p>
                </div>
                <div className="border-t border-brown-700 pt-4 flex-1">
                  <ul className="space-y-2 text-sm text-brown-300">
                    <li className="flex items-center gap-2"><span className="text-mesa-accent">✓</span> Full library access</li>
                    <li className="flex items-center gap-2"><span className="text-mesa-accent">✓</span> Weekly new content</li>
                    <li className="flex items-center gap-2"><span className="text-mesa-accent">✓</span> All skill levels</li>
                    <li className="flex items-center gap-2"><span className="text-mesa-accent">✓</span> Cancel anytime</li>
                  </ul>
                </div>
                <button
                  disabled
                  className={`mt-2 w-full rounded-lg py-3 font-semibold text-sm transition ${
                    plan.highlight
                      ? "bg-mesa-accent text-white opacity-60 cursor-not-allowed"
                      : "border border-brown-600 text-brown-400 opacity-60 cursor-not-allowed"
                  }`}
                >
                  Coming Soon
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="bg-mesa-accent py-14 md:py-16">
        <div className="mx-auto max-w-2xl px-6 text-center">
          <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl md:text-5xl font-black tracking-wide text-white mb-3">
            LAUNCHING SOON.
          </h2>
          <p className="text-white/80 text-lg">
            Questions? Call or text <a href="tel:6315991280" className="font-bold text-white hover:underline">(631) 599-1280</a>
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-brown-800 bg-mesa-dark py-12">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="font-[family-name:var(--font-oswald)] text-2xl font-bold tracking-wide">Get in Touch</h2>
          <div className="mt-4 space-y-1 text-brown-300">
            <p>
              <span className="font-semibold text-white">Call / Text:</span>{" "}
              <a href="tel:6315991280" className="hover:text-mesa-accent">(631) 599-1280</a>
            </p>
            <p>
              <span className="font-semibold text-white">Email:</span>{" "}
              <a href="mailto:artemios@mesabasketballtraining.com" className="hover:text-mesa-accent">
                artemios@mesabasketballtraining.com
              </a>
            </p>
          </div>
          <div className="mt-3 flex justify-center">
            <a
              href="https://www.instagram.com/mesabasketballtraining"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Instagram"
              className="text-brown-400 hover:text-white transition"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
              </svg>
            </a>
          </div>
          <p className="mt-4 text-sm text-brown-600">
            &copy; 2025&ndash;{new Date().getFullYear()} Mesa Basketball Training LLC. All rights reserved.
          </p>
          <div className="mt-3 flex justify-center gap-8 text-sm">
            <Link href="/privacy-policy" className="text-mesa-accent hover:text-yellow-300">Privacy Policy</Link>
            <Link href="/terms" className="text-mesa-accent hover:text-yellow-300">Terms &amp; Conditions</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
