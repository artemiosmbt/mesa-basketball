import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "About | Mesa Basketball Training",
  description:
    "Learn about Artemios Gavalas, former Division I point guard, professional player, and founder of Mesa Basketball Training.",
};

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-brown-800 bg-mesa-dark/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/" className="flex items-center gap-2 text-lg font-bold text-white">
            <img src="/logo.jpeg" alt="Mesa Basketball Logo" className="h-10 w-10 rounded-full object-cover" />
            <span className="hidden sm:inline">ΜΕΣΑ BASKETBALL</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/#schedule" className="hidden md:inline text-brown-300 hover:text-white">Schedule</Link>
            <Link href="/#camps" className="hidden md:inline text-brown-300 hover:text-white">Camps</Link>
            <Link href="/#private" className="hidden md:inline text-brown-300 hover:text-white">Private Sessions</Link>
            <Link href="/about" className="hidden md:inline text-mesa-accent font-medium">About</Link>
            <a href="https://www.instagram.com/mesabasketballtraining" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="hidden md:inline text-brown-300 hover:text-white">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
              </svg>
            </a>
            <Link href="/my-bookings" className="rounded bg-mesa-accent/20 px-3 py-1 text-mesa-accent hover:bg-mesa-accent/30">My Bookings</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-mesa-dark via-brown-900 to-brown-800 py-20 md:py-28">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col items-center text-center">
            <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-mesa-accent">
              Founder &amp; Head Trainer
            </p>
            <h1 className="font-[family-name:var(--font-fira-cond)] text-5xl font-black tracking-wide md:text-7xl">
              ARTEMIOS GAVALAS
            </h1>
            <p className="mt-5 max-w-xl text-brown-300 text-lg leading-relaxed">
              Former Division I Point Guard. Professional Athlete. Trainer. Community Builder.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3 text-sm text-brown-300">
              <span className="rounded-full border border-brown-700 px-4 py-1">St. John&apos;s University</span>
              <span className="rounded-full border border-brown-700 px-4 py-1">Butler University</span>
              <span className="rounded-full border border-brown-700 px-4 py-1">Professional Player in Greece</span>
              <span className="rounded-full border border-brown-700 px-4 py-1">5+ Years Training</span>
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
          <div className="space-y-5 text-brown-200 leading-relaxed text-[17px]">
            <p>
              Mesa Basketball Training was built out of a genuine love for the game and a deep commitment to
              helping others grow through it. For Artemios Gavalas, training has always been a passion, something
              he has poured himself into throughout his playing career and beyond. Long before Mesa had a name,
              he was in the gym during offseasons, working with players, refining his craft as a trainer, and
              developing an approach that was intentional, creative, and results-driven.
            </p>
            <p>
              What started as a passion grew into a program. Mesa is rooted in the same community Artemios grew
              up in, and that connection matters deeply. This is not a program built from a distance. It is built
              from the same courts, the same neighborhoods, and the same hunger to be great.
            </p>
            <p>
              Over five years and hundreds of athletes later, from 4-year-olds picking up a ball for the first
              time to adult professionals sharpening their edge, Mesa has become a place where real development
              happens. Not shortcuts. Not gimmicks. Just consistent, intentional work that produces results on and
              off the court.
            </p>
          </div>
        </section>

        {/* Playing career */}
        <section>
          <h2 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide text-mesa-accent mb-6">
            PLAYING CAREER
          </h2>
          <div className="space-y-5 text-brown-200 leading-relaxed text-[17px] mb-8">
            <p>
              Artemios competed as a point guard at the Division I level, suiting up for two of college
              basketball&apos;s most storied programs: St. John&apos;s University and Butler University, both
              members of the prestigious Big East Conference. Competing in one of the most demanding conferences
              in the country, he trained alongside and against elite talent day in and day out, developing a
              deep understanding of the game at its highest collegiate level.
            </p>
            <p>
              He went on to continue his career professionally in Greece, gaining firsthand experience in
              European professional basketball, a system known for its emphasis on skill, IQ, and fundamentals.
              That combination of American Division I intensity and European technical discipline is the
              foundation every Mesa session is built on.
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

        {/* Training philosophy */}
        <section>
          <h2 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide text-mesa-accent mb-6">
            THE APPROACH
          </h2>
          <div className="space-y-5 text-brown-200 leading-relaxed text-[17px]">
            <p>
              Great trainers do not just run drills. They teach the game. At Mesa, every session is
              thoughtfully designed with creativity and purpose. The goal is not to go through the motions.
              It is to understand <em>why</em> each skill matters and how it translates to live game situations.
              That kind of intentional training is what separates players who look good in drills from players
              who perform when it counts.
            </p>
            <p>
              Artemios brings a point guard&apos;s mind to every session, reading situations, making adjustments,
              and finding the right way to connect with each athlete individually. Whether working with a beginner
              or a seasoned player, the energy in the gym stays high, the expectations stay real, and the
              creativity keeps players engaged and progressing.
            </p>
            <p>
              The lessons go beyond basketball. Dedication, consistency, showing up when it is hard, and chasing
              your goals with discipline are values that carry athletes far beyond the court and into every area
              of their lives. Mesa is committed to developing people, not just players.
            </p>
          </div>
        </section>

        {/* Stats / highlights */}
        <section>
          <div className="grid gap-6 sm:grid-cols-3 text-center">
            {[
              { stat: "5+", label: "Years Training Athletes" },
              { stat: "4 to Pro", label: "Ages Trained" },
              { stat: "D1 + Pro", label: "Playing Pedigree" },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-lg border border-brown-700 bg-brown-900/40 px-6 py-8"
              >
                <p className="font-[family-name:var(--font-fira-cond)] text-4xl font-black text-mesa-accent">
                  {item.stat}
                </p>
                <p className="mt-2 text-sm text-brown-400 font-medium uppercase tracking-wide">
                  {item.label}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* What we offer */}
        <section>
          <h2 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide text-mesa-accent mb-6">
            WHAT WE OFFER
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              {
                title: "Group Sessions",
                desc: "Structured skill development in a competitive small-group setting. Players push each other, learn together, and leave better every single time.",
              },
              {
                title: "Mini Camps",
                desc: "Intensive multi-day programs built for accelerated development. High reps, high energy, and focused training blocks designed to elevate your game fast.",
              },
              {
                title: "Private Training",
                desc: "One-on-one or small group sessions completely tailored to your individual goals. Maximum attention, maximum growth.",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-lg border border-brown-700 bg-brown-900/40 px-6 py-6"
              >
                <p className="font-semibold text-white text-lg mb-2">{item.title}</p>
                <p className="text-sm text-brown-400 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Quote */}
        <section className="border-l-4 border-mesa-accent pl-6">
          <blockquote className="text-brown-200 text-xl leading-relaxed italic">
            &ldquo;I started Mesa because I wanted to give players access to the kind of training and mentorship
            that shaped me. If I can take everything I&apos;ve learned from some of the best programs and coaches
            in the world and pass that on to kids in my own community, that is everything. That is the whole point.&rdquo;
          </blockquote>
          <p className="mt-4 text-mesa-accent font-semibold text-sm uppercase tracking-widest">
            Artemios Gavalas, Founder
          </p>
        </section>

        {/* CTA */}
        <section className="rounded-xl border border-brown-700 bg-brown-900/40 px-8 py-10 text-center">
          <h2 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide mb-3">
            READY TO GET TO WORK?
          </h2>
          <p className="text-brown-300 mb-6 max-w-lg mx-auto">
            Whether your child is just starting out or looking to take their game to the next level,
            there&apos;s a spot for them at Mesa. Browse available sessions and lock in your booking today.
          </p>
          <Link
            href="/"
            className="inline-block rounded bg-mesa-accent px-8 py-3 font-semibold text-white hover:bg-mesa-accent/90 transition"
          >
            View Schedule &amp; Book
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
          <div className="mt-6 flex items-center justify-center gap-4">
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
