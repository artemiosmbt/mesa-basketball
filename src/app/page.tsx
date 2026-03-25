import type { Metadata } from "next";
import Link from "next/link";
import LandingNav from "./LandingNav";

export const metadata: Metadata = {
  title: "Mesa Basketball Training | Long Island",
  description:
    "Elite basketball training on Long Island with former D1 and professional player Artemios Gavalas. Group sessions, mini camps, and private training for all ages.",
  keywords: ["basketball training Long Island", "youth basketball training Long Island", "elite basketball trainer Long Island", "private basketball training near me", "basketball camps Long Island", "AAU basketball training", "basketball training Nassau County", "basketball training Suffolk County", "basketball trainer Long Island", "Mesa Basketball", "Artemios Gavalas", "D1 basketball trainer", "professional basketball trainer Long Island"],
  openGraph: {
    title: "Mesa Basketball Training | Long Island",
    description: "Elite basketball training on Long Island with former D1 and professional player Artemios Gavalas. Serving Nassau County, Suffolk County, and The Hamptons.",
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
              Long Island&apos;s Elite Basketball Training
            </p>
            <h1 className="font-[family-name:var(--font-fira-cond)] text-6xl font-black tracking-wide md:text-8xl leading-none">
              TRAIN WITH<br />PURPOSE.
            </h1>
            <p className="mt-6 max-w-xl text-brown-300 text-lg leading-relaxed">
              Elite development for all levels — led by former D1 point guard and international athlete <span className="text-white font-semibold">Artemios Gavalas</span>.
            </p>
            <div className="mt-10 flex flex-wrap justify-center gap-4">
              <Link
                href="/schedule#schedule"
                className="rounded-lg bg-mesa-accent px-8 py-3 font-semibold text-white hover:bg-yellow-600 transition"
              >
                View Programs
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
          <p className="font-[family-name:var(--font-fira-cond)] text-2xl md:text-3xl font-black tracking-wide text-white mb-8">
            Built From Experience<span className="text-mesa-accent"> — </span>Designed for Real Growth.
          </p>
          <div className="border-l-4 border-mesa-accent pl-6">
            <blockquote className="text-brown-200 text-xl md:text-2xl leading-relaxed italic">
              &ldquo;Mesa was built to give players access to the level of training, mindset, and mentorship that shaped my career. Everything I learned from some of the best programs and coaches in the world, I now bring directly to every athlete I work with. My goal is simple, pass that on to the next generation in my own community.&rdquo;
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
            <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-2">The Approach</p>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide">A DIFFERENT STANDARD OF TRAINING</h2>
          </div>
          <div className="grid gap-8 md:grid-cols-3 text-center">
            {[
              {
                heading: "We Teach the Game — Not Just Drills",
                body: "Players develop basketball IQ, decision-making, and real game awareness so skills translate under pressure.",
              },
              {
                heading: "Real Development. Real Results.",
                body: "No gimmicks. No wasted reps. Every session is designed for measurable improvement in skill, confidence, and performance.",
              },
              {
                heading: "Built Beyond Basketball",
                body: "We train discipline, focus, and resilience, because great players are built mentally as much as physically.",
              },
            ].map((item) => (
              <div key={item.heading} className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-8">
                <p className="font-[family-name:var(--font-fira-cond)] text-xl font-black tracking-wide text-mesa-accent mb-3 leading-snug">{item.heading}</p>
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
            <span className="text-white font-semibold">ΜΕΣΑ</span> is the Greek word for &ldquo;in.&rdquo; In basketball, it is the call you hear the moment a shot finds the net. It represents precision. Confidence. Execution. A word that has followed Artemios his entire life and now defines how players train.
          </p>
        </div>
      </section>

      {/* What We Offer */}
      <section className="bg-gradient-to-b from-brown-950 to-mesa-dark border-t border-brown-800 py-16 md:py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="text-center mb-12">
            <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-2">Training Programs for Every Level</p>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide">
              FIND YOUR FIT
            </h2>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {[
              {
                title: "Group Training Sessions",
                tag: "Competitive. Structured. Consistent.",
                desc: "Small group basketball training focused on skill development, game situations, and live competition. Perfect for players who want to improve while being pushed by others.",
                anchor: "/schedule#schedule",
              },
              {
                title: "Mini Camps",
                tag: "Accelerated Development. Maximum Reps.",
                desc: "Multi-day intensive camps built for rapid skill growth, competitive games, and confidence-building in a high-energy environment.",
                anchor: "/schedule#camps",
              },
              {
                title: "Private Training",
                tag: "Personalized. Focused. Elite.",
                desc: "Customized training programs built around your position, goals, and development needs.",
                anchor: "/schedule#private",
              },
            ].map((item) => (
              <Link
                key={item.title}
                href={item.anchor}
                className="group rounded-xl border border-brown-700 bg-brown-900/40 px-7 py-8 hover:border-mesa-accent/60 hover:bg-brown-900/70 transition"
              >
                <p className="text-xs font-semibold text-mesa-accent mb-3 whitespace-nowrap">{item.tag}</p>
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

      {/* Credentials & Detail */}
      <section className="bg-brown-950 py-16 md:py-24 border-t border-brown-800">
        <div className="mx-auto max-w-6xl px-6">

          {/* Section heading */}
          <div className="text-center mb-12">
            <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-2">Proven Experience. Trusted Development.</p>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide">WHY MESA</h2>
          </div>

          {/* Stats bar */}
          <div className="grid grid-cols-3 gap-6 text-center mb-14">
            {[
              { stat: "5+", label: "Years Training Athletes" },
              { stat: "Age 4–Pro", label: "Athletes Trained" },
              { stat: "D1 + Pro", label: "Playing Pedigree" },
            ].map((item) => (
              <div key={item.label}>
                <p className="font-[family-name:var(--font-fira-cond)] text-4xl md:text-5xl font-black text-mesa-accent">{item.stat}</p>
                <p className="mt-2 text-xs text-brown-400 font-medium uppercase tracking-wide">{item.label}</p>
              </div>
            ))}
          </div>

          {/* Three columns */}
          <div className="grid gap-8 md:grid-cols-3">

            {/* Who We Train */}
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-8">
              <p className="font-[family-name:var(--font-fira-cond)] text-xl font-black tracking-wide text-mesa-accent mb-4">Who We Train</p>
              <ul className="space-y-3 text-sm text-brown-300">
                <li><span className="text-white font-semibold">Beginner</span><br /><span className="text-brown-400">Building fundamentals, coordination, and a love for the game</span></li>
                <li><span className="text-white font-semibold">Intermediate</span><br /><span className="text-brown-400">Developing skills, basketball IQ, and competitive instincts</span></li>
                <li><span className="text-white font-semibold">Advanced</span><br /><span className="text-brown-400">Elevating performance, game speed, and court vision</span></li>
                <li><span className="text-white font-semibold">College &amp; Pro</span><br /><span className="text-brown-400">Year-round development for competitive athletes at the highest levels</span></li>
              </ul>
            </div>

            {/* What Players Gain */}
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-8">
              <p className="font-[family-name:var(--font-fira-cond)] text-xl font-black tracking-wide text-mesa-accent mb-4">What Players Gain</p>
              <ul className="space-y-2 text-sm text-brown-300">
                {[
                  "Elite ball handling & scoring ability",
                  "Improved shooting mechanics",
                  "Game-speed decision making",
                  "Confidence under pressure",
                  "Stronger mindset & discipline",
                  "Athletes trained have gone on to compete at the high school and college level across Long Island",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <span className="text-mesa-accent mt-0.5">◆</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Where We Train */}
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-8">
              <p className="font-[family-name:var(--font-fira-cond)] text-xl font-black tracking-wide text-mesa-accent mb-4">Basketball Training on Long Island</p>
              <p className="text-sm text-brown-400 mb-3">Mesa serves athletes across Nassau County, Suffolk County, and The Hamptons — including:</p>
              <p className="text-sm text-brown-300 leading-relaxed">
                Hempstead, Garden City, Mineola, Westbury, Uniondale, Hicksville, Levittown, Massapequa, Babylon, Bay Shore, Islip, Brentwood, Hauppauge, Smithtown, Huntington, Commack, East Hampton, Southampton, Bridgehampton, and surrounding areas.
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* CTA Banner */}
      <section className="bg-mesa-accent py-16 md:py-20">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl md:text-5xl font-black tracking-wide text-white mb-4">
            SERIOUS ABOUT GETTING BETTER?
          </h2>
          <p className="text-white/80 text-lg mb-8 max-w-xl mx-auto">
            From first-time players to seasoned athletes, Mesa has a program built for every level. Browse available sessions and lock in your booking today.
          </p>
          <Link
            href="/schedule"
            className="inline-block rounded-lg bg-white px-10 py-4 font-bold text-mesa-accent text-lg hover:bg-brown-100 transition"
          >
            View Programs &amp; Book Now
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
          <div className="mt-3 flex justify-center gap-8 text-sm">
            <a href="/privacy-policy" className="text-mesa-accent hover:text-yellow-300">Privacy Policy</a>
            <a href="/terms" className="text-mesa-accent hover:text-yellow-300">Terms &amp; Conditions</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
