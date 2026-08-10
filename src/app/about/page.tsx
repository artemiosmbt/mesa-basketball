import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import LandingNav from "../LandingNav";
import TrainerVideo from "../TrainerVideo";
import { sortedTrainers } from "@/lib/trainer-bios";

export const metadata: Metadata = {
  title: "About Us | Mesa Basketball Training",
  description:
    "Meet the Mesa Basketball Training team, led by founder Artemios Gavalas — a former Division I point guard at St. John's University and Butler University and international professional basketball player — alongside our trainers on Long Island.",
  keywords: [
    "Artemios Gavalas",
    "Artemios Gavalas basketball",
    "Artemios Gavalas trainer",
    "Artemios Gavalas Long Island",
    "basketball coach Long Island",
    "D1 basketball trainer",
    "professional basketball trainer Long Island",
    "elite basketball coaching Long Island",
    "Mesa Basketball Training about",
    "Mesa Basketball Training trainers",
  ],
  alternates: {
    canonical: "/about",
  },
  openGraph: {
    title: "About Us | Mesa Basketball Training",
    description: "Meet the Mesa Basketball Training team, led by founder Artemios Gavalas — former D1 point guard at St. John's and Butler University and international professional player — alongside our trainers on Long Island.",
    url: "https://www.mesabasketballtraining.com/about",
    images: [{ url: "/og-image.jpg", width: 1200, height: 630 }],
  },
};

const personJsonLd = {
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "Artemios Gavalas",
  "url": "https://www.mesabasketballtraining.com/about",
  "image": "https://www.mesabasketballtraining.com/headshot.jpg",
  "jobTitle": "Basketball Trainer & Founder",
  "description": "Former Division I point guard at St. John's University and Butler University, international professional basketball player in Greece, and founder of Mesa Basketball Training on Long Island.",
  "worksFor": {
    "@type": "Organization",
    "name": "Mesa Basketball Training",
    "url": "https://www.mesabasketballtraining.com"
  },
  "alumniOf": [
    { "@type": "CollegeOrUniversity", "name": "St. John's University" },
    { "@type": "CollegeOrUniversity", "name": "Butler University" }
  ],
  "sameAs": [
    "https://www.instagram.com/artemigavalas",
    "https://www.instagram.com/mesabasketballtraining",
    "https://www.mesabasketballtraining.com"
  ]
};

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }}
      />
      {/* Nav */}
      <LandingNav />

      {/* Hero */}
      <section id="artemios-gavalas" className="relative overflow-hidden bg-gradient-to-br from-mesa-dark via-brown-900 to-brown-800 py-20 md:py-28 scroll-mt-20">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col items-center text-center">
            <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-mesa-accent">
              Founder &amp; Head Trainer
            </p>
            <div className="mb-5 rounded-full p-[4px] bg-white/90 shadow-lg shadow-black/40 ring-2 ring-mesa-accent/40">
              <div
                className="h-28 w-28 rounded-full"
                style={{
                  backgroundImage: "url(/headshot.jpg)",
                  backgroundSize: "cover",
                  backgroundPosition: "50% 30%",
                }}
              />
            </div>
            <h1 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide md:text-4xl">
              ARTEMIOS GAVALAS
            </h1>
            <p className="mt-4 text-brown-300 text-base">
              Former Division I Point Guard &nbsp;&bull;&nbsp; Professional Experience &nbsp;&bull;&nbsp; 5+ Year Trainer
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3 text-sm text-brown-300">
              <span className="rounded-full border border-brown-700 px-4 py-1">St. John&apos;s University</span>
              <span className="rounded-full border border-brown-700 px-4 py-1">Butler University</span>
              <span className="rounded-full border border-brown-700 px-4 py-1">Greece</span>
            </div>
          </div>
        </div>
      </section>

      {/* Main content */}
      <main className="mx-auto max-w-4xl px-6 py-16 md:py-20 space-y-16">

        {/* Why Mesa */}
        <section>
          <h2 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide text-mesa-accent mb-6">
            WHY MESA EXISTS
          </h2>
          <div className="flex flex-col md:flex-row gap-10 items-center">
            <div className="space-y-5 text-brown-200 leading-relaxed text-[17px] flex-1">
              <p>
                I built Mesa out of a genuine love for the game and a deep commitment to helping others grow through it.
                Training has always been a passion of mine, something I poured myself into throughout my playing career
                and beyond. Long before Mesa had a name, I was in the gym during offseasons, working with players,
                refining my craft as a trainer, and developing an approach that was intentional, creative, and results-driven.
              </p>
              <p>
                What started as a passion grew into a program. Mesa is rooted in the same community I grew up in, and
                that connection matters deeply to me. This is not a program built from a distance. It is built from the
                same courts, the same neighborhoods, and the same hunger to be great.
              </p>
              <p>
                Over five years and hundreds of athletes later, from 4-year-olds picking up a ball for the first time
                to adult professionals sharpening their edge, Mesa has become a place where real development happens.
                No shortcuts. No gimmicks. Just consistent, intentional work that produces results on and off the court.
              </p>
            </div>
            {/* Photo alongside text */}
            <div className="relative w-full aspect-[3/4] md:h-auto md:w-72 md:aspect-[3/4] rounded-xl overflow-hidden flex-shrink-0 shadow-xl">
              <Image
                src="/photos/grid7.jpg"
                alt="Artemios coaching shooting form"
                fill
                className="object-cover object-[center_30%]"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-mesa-dark/50 via-transparent to-transparent" />
            </div>
          </div>
        </section>

        {/* Playing career */}
        <section>
          <h2 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide text-mesa-accent mb-6">
            PLAYING CAREER
          </h2>
          <div className="space-y-5 text-brown-200 leading-relaxed text-[17px] mb-8">
            <p>
              I competed as a point guard at the Division I level, suiting up for two of college basketball&apos;s
              most storied programs: St. John&apos;s University and Butler University, both members of the prestigious
              Big East Conference. Competing in one of the most demanding conferences in the country, I trained
              alongside and against elite talent day in and day out, developing a deep understanding of the game
              at its highest collegiate level.
            </p>
            <p>
              I went on to continue my career internationally in Greece, gaining firsthand experience in European
              professional basketball, a system known for its emphasis on skill, IQ, and fundamentals. That
              combination of American Division I intensity and European technical discipline is the foundation
              every Mesa session is built on.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              {
                school: "St. John's University",
                detail: "Division I  •  Big East Conference",
                photo: "/photo1.jpg",
                alt: "Artemios Gavalas at St. John's",
                position: "center 35%",
              },
              {
                school: "Butler University",
                detail: "Division I  •  Big East Conference",
                photo: "/photo2.jpg",
                alt: "Artemios Gavalas at Butler",
                position: "center top",
              },
            ].map((stop) => (
              <div
                key={stop.school}
                className="rounded-lg border border-brown-700 bg-brown-900/40 overflow-hidden"
              >
                <div className="relative w-full overflow-hidden" style={{ aspectRatio: "3/4" }}>
                  <Image
                    src={stop.photo}
                    alt={stop.alt}
                    fill
                    className="object-cover"
                    style={{ objectPosition: stop.position }}
                  />
                </div>
                <div className="px-6 py-4">
                  <p className="font-semibold text-white">{stop.school}</p>
                  <p className="mt-1 text-sm text-brown-400">{stop.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Our Trainers — grows alphabetically by last name as more join.
            Each trainer's header (centered, circular headshot, big name)
            mirrors Artemios's own hero section above exactly; their bio
            reads in the same text-alongside-media layout as his "Why Mesa
            Exists" section, just with a video slot instead of a photo. */}
        {sortedTrainers.length > 0 && (
          <div className="relative left-1/2 right-1/2 -mx-[50vw] w-screen overflow-hidden bg-gradient-to-b from-brown-600 via-brown-700 to-brown-800 shadow-[0_15px_40px_-10px_rgba(0,0,0,0.6)]">
            {/* Thin top highlight simulates a raised/beveled edge instead of a flat color fill */}
            <div className="absolute inset-x-0 top-0 h-px bg-white/15" />
            <div className="mx-auto max-w-6xl px-6 py-12 text-center">
              <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl md:text-5xl font-black tracking-wide text-mesa-accent drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
                MEET THE TEAM
              </h2>
            </div>
          </div>
        )}
        {sortedTrainers.length > 0 && sortedTrainers.map((trainer, i) => (
          <Fragment key={trainer.slug}>
            {i > 0 && (
              <div className="py-4">
                <div className="flex items-center gap-4">
                  <div className="h-px flex-1 bg-gradient-to-r from-transparent to-mesa-accent/70" />
                  <div className="h-2 w-2 rotate-45 bg-mesa-accent" />
                  <div className="h-px flex-1 bg-gradient-to-l from-transparent to-mesa-accent/70" />
                </div>
              </div>
            )}
            <section id={trainer.slug} className="scroll-mt-20">
            {/* Full-bleed gradient band behind the headshot/name/pills, matching
                Artemios's own hero section above — breaks out of <main>'s
                max-w-4xl to span the full viewport width. Pulled up slightly
                (-mt-8) to tighten the gap under the Meet the Team band / the
                divider above each trainer — space-y-16 on <main> alone left
                too much empty space before "TRAINER" ever appears. */}
            <div className="relative left-1/2 right-1/2 -mx-[50vw] w-screen overflow-hidden bg-gradient-to-br from-mesa-dark via-brown-900 to-brown-800 py-20 md:py-28 mb-10 -mt-8">
              <div className="mx-auto max-w-6xl px-6 flex flex-col items-center text-center">
                <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-mesa-accent">
                  {trainer.title}
                </p>
                <div className="mb-5 rounded-full p-[4px] bg-white/90 shadow-lg shadow-black/40 ring-2 ring-mesa-accent/40">
                  <div
                    className="h-28 w-28 rounded-full"
                    style={{
                      backgroundImage: `url(${trainer.headshot})`,
                      backgroundSize: "cover",
                      backgroundPosition: trainer.headshotPosition || "center",
                    }}
                  />
                </div>
                <h2 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide md:text-4xl">
                  {trainer.displayName.toUpperCase()}
                </h2>
                {trainer.pills.length > 0 && (
                  <div className="mt-6 flex flex-wrap justify-center gap-3 text-sm text-brown-300">
                    {trainer.pills.map((pill) => (
                      <span key={pill} className="rounded-full border border-brown-700 px-4 py-1">{pill}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-col md:flex-row gap-10 items-center">
              <div className="space-y-5 text-brown-200 leading-relaxed text-[17px] flex-1">
                {trainer.bioParagraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
              {trainer.videoUrl && (
                <div className="relative w-full aspect-[3/4] md:h-auto md:w-72 md:aspect-[3/4] rounded-xl overflow-hidden flex-shrink-0 shadow-xl bg-black pointer-events-none">
                  <TrainerVideo
                    src={trainer.videoUrl}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                </div>
              )}
              {!trainer.videoUrl && trainer.photos && trainer.photos.length > 0 && (
                <div className="flex flex-row md:flex-col gap-4 w-full md:w-72 flex-shrink-0">
                  {trainer.photos.map((photo) => (
                    <div key={photo} className="relative w-full aspect-[3/4] rounded-xl overflow-hidden shadow-xl">
                      <Image src={photo} alt={`${trainer.displayName} coaching`} fill className="object-cover" />
                    </div>
                  ))}
                </div>
              )}
            </div>
            </section>
          </Fragment>
        ))}

        {/* CTA */}
        <section className="rounded-xl border border-brown-700 bg-brown-900/40 px-8 py-10 text-center">
          <h2 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide mb-3">
            READY TO GET TO WORK?
          </h2>
          <p className="text-brown-300 mb-6 max-w-lg mx-auto">
            From first-time players to seasoned athletes, Mesa has a program built for every level. Browse available sessions and lock in your booking today.
          </p>
          <Link
            href="/schedule"
            className="inline-block rounded bg-mesa-accent px-8 py-3 font-semibold text-white hover:bg-mesa-accent/90 transition"
          >
            View Programs &amp; Book
          </Link>
        </section>

      </main>

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
