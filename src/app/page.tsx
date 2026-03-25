import type { Metadata } from "next";
import Link from "next/link";
import LandingNav from "./LandingNav";

export const metadata: Metadata = {
  title: "Mesa Basketball Training | Long Island",
  description:
    "Elite basketball training on Long Island with former D1 and professional player Artemios Gavalas. Group sessions, mini camps, and private training for all ages.",
  keywords: ["basketball training", "Long Island basketball", "basketball camps Long Island", "private basketball training", "youth basketball Long Island", "Mesa Basketball"],
  openGraph: {
    title: "Mesa Basketball Training | Long Island",
    description: "Elite basketball training on Long Island with former D1 and professional player Artemios Gavalas.",
    url: "https://www.mesabasketballtraining.com",
    siteName: "Mesa Basketball Training",
    images: [{ url: "https://www.mesabasketballtraining.com/og-image.jpg" }],
    type: "website",
  },
};

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      <LandingNav />

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-mesa-dark via-brown-900 to-brown-800">
        <div className="mx-auto max-w-6xl px-6 py-24 md:py-36">
          <div className="flex flex-col items-center text-center">
            <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-mesa-accent">
              Long Island&apos;s Premier Basketball Training
            </p>
            <h1 className="font-[family-name:var(--font-fira-cond)] text-6xl font-black tracking-wide md:text-8xl leading-none">
              TRAIN WITH<br />PURPOSE.
            </h1>
            <p className="mt-6 max-w-2xl text-brown-300 text-lg md:text-xl leading-relaxed">
              Elite basketball development with <span className="text-white font-semibold">Artemios Gavalas</span> —
              former Division I point guard, professional athlete, and lifelong student of the game.
            </p>
            <div className="mt-10 flex flex-wrap justify-center gap-4">
              <Link
                href="/schedule#schedule"
                className="rounded-lg bg-mesa-accent px-8 py-3 font-semibold text-white hover:bg-yellow-600 transition"
              >
                View Schedule &amp; Book
              </Link>
              <Link
                href="/about"
                className="rounded-lg border border-brown-600 px-8 py-3 font-semibold text-brown-300 hover:border-brown-400 hover:text-white transition"
              >
                Meet the Trainer
              </Link>
            </div>
          </div>
        </div>
        {/* Subtle bottom fade */}
        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-mesa-dark to-transparent" />
      </section>

      {/* Quote */}
      <section className="bg-mesa-dark py-16 md:py-20">
        <div className="mx-auto max-w-3xl px-6">
          <div className="border-l-4 border-mesa-accent pl-6">
            <blockquote className="text-brown-200 text-xl md:text-2xl leading-relaxed italic">
              &ldquo;I started Mesa because I wanted to give players access to the kind of training and mentorship
              that shaped me. If I can take everything I&apos;ve learned from some of the best programs and coaches
              in the world and pass that on to players in my own community, that&apos;s the whole point.&rdquo;
            </blockquote>
            <p className="mt-4 text-mesa-accent font-semibold text-sm uppercase tracking-widest">
              Artemios Gavalas &mdash; Founder, Mesa Basketball Training
            </p>
          </div>
        </div>
      </section>

      {/* The Approach */}
      <section className="bg-brown-950 border-t border-brown-800 py-16 md:py-24">
        <div className="mx-auto max-w-4xl px-6">
          <div className="text-center mb-10">
            <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-2">What Sets Mesa Apart</p>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide">THE APPROACH</h2>
          </div>
          <div className="grid gap-8 md:grid-cols-3 text-center">
            {[
              {
                heading: "We Teach the Game",
                body: "Every session is built around understanding why each skill matters, not just running drills. Players learn how it translates to real game situations.",
              },
              {
                heading: "Real Development",
                body: "No shortcuts, no gimmicks. Just consistent, intentional work designed to produce results on the court and develop character off of it.",
              },
              {
                heading: "Beyond Basketball",
                body: "Dedication, discipline, and showing up when it is hard. The lessons players take from Mesa carry into every area of their lives.",
              },
            ].map((item) => (
              <div key={item.heading} className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-8">
                <p className="font-[family-name:var(--font-fira-cond)] text-xl font-black tracking-wide text-mesa-accent mb-3">{item.heading}</p>
                <p className="text-sm text-brown-400 leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* The Name */}
      <section className="bg-brown-950 border-t border-brown-800 py-14 md:py-20">
        <div className="mx-auto max-w-2xl px-6 text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-4">The Name</p>
          <p className="text-brown-300 text-lg md:text-xl leading-relaxed">
            <span className="text-white font-semibold">ΜΕΣΑ</span> is the Greek word for &ldquo;in.&rdquo; In basketball, it is the call you hear the moment a shot finds the net. It is a word that has followed me my whole life, and when I started this program, no other name came close.
          </p>
        </div>
      </section>

      {/* What We Offer */}
      <section className="bg-gradient-to-b from-brown-950 to-mesa-dark py-16 md:py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="text-center mb-12">
            <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-2">Programs</p>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide">
              FIND YOUR FIT
            </h2>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {[
              {
                title: "Group Sessions",
                tag: "Weekly",
                desc: "Structured skill development in a competitive small-group setting. Players push each other, learn together, and walk out better every single time.",
                anchor: "/schedule#schedule",
              },
              {
                title: "Mini Camps",
                tag: "Intensive",
                desc: "Multi-day programs built for accelerated development. High reps, high energy, and focused training blocks designed to elevate your game fast.",
                anchor: "/schedule#camps",
              },
              {
                title: "Private Training",
                tag: "1-on-1 & Small Group",
                desc: "Sessions completely tailored to your individual goals. Maximum attention, maximum growth, on your schedule.",
                anchor: "/schedule#private",
              },
            ].map((item) => (
              <Link
                key={item.title}
                href={item.anchor}
                className="group rounded-xl border border-brown-700 bg-brown-900/40 px-7 py-8 hover:border-mesa-accent/60 hover:bg-brown-900/70 transition"
              >
                <p className="text-xs font-semibold uppercase tracking-widest text-mesa-accent mb-3">{item.tag}</p>
                <p className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-3 group-hover:text-mesa-accent transition">
                  {item.title}
                </p>
                <p className="text-sm text-brown-400 leading-relaxed">{item.desc}</p>
                <p className="mt-5 text-sm font-semibold text-mesa-accent group-hover:text-yellow-400 transition">
                  View &amp; Book &rarr;
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="bg-brown-950 py-16 md:py-20 border-t border-brown-800">
        <div className="mx-auto max-w-4xl px-6">
          <div className="grid grid-cols-3 gap-6 text-center">
            {[
              { stat: "5+", label: "Years Training Athletes" },
              { stat: "4 yrs to Pro", label: "Ages Trained" },
              { stat: "D1 + Pro", label: "Playing Pedigree" },
            ].map((item) => (
              <div key={item.label}>
                <p className="font-[family-name:var(--font-fira-cond)] text-4xl md:text-5xl font-black text-mesa-accent">
                  {item.stat}
                </p>
                <p className="mt-2 text-xs md:text-sm text-brown-400 font-medium uppercase tracking-wide">
                  {item.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Banner */}
      <section className="bg-mesa-accent py-16 md:py-20">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl md:text-5xl font-black tracking-wide text-white mb-4">
            READY TO GET TO WORK?
          </h2>
          <p className="text-white/80 text-lg mb-8 max-w-xl mx-auto">
            From first-time players to seasoned athletes, Mesa has a program built for every level. Browse available sessions and lock in your booking today.
          </p>
          <Link
            href="/schedule"
            className="inline-block rounded-lg bg-white px-10 py-4 font-bold text-mesa-accent text-lg hover:bg-brown-100 transition"
          >
            View Schedule &amp; Book Now
          </Link>
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
          <div className="mt-3 flex flex-col items-center gap-2">
            <a href="/my-bookings" className="text-sm text-mesa-accent hover:text-yellow-300">
              My Bookings &mdash; Look Up Your Registrations
            </a>
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
        </div>
      </footer>
    </div>
  );
}
