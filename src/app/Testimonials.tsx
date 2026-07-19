"use client";

import { useRef, useState } from "react";

const GOOGLE_REVIEWS_URL = "https://share.google/ar2S4cjDrW5cx7wbc";

interface Testimonial {
  name: string;
  text: string;
  color: string;
}

const testimonials: Testimonial[] = [
  {
    name: "Dianna Kazakis",
    color: "bg-orange-600",
    text: "For over a year, both of my children—a 14-year-old son and a 12-year-old daughter—have trained with Coach Artemios. During that time, their skills, confidence, and love for the game have grown tremendously. Coach Artemios tailors each lesson to the individual player's level, helping them develop both technically and mentally. I've watched my children go from players with limited experience to key contributors on their teams. His dedication, patience, and ability to bring out the best in each athlete have made a tremendous impact. We are so grateful for everything he has done and highly recommend him to any player looking to improve their game.",
  },
  {
    name: "Daniel O'Connell",
    color: "bg-indigo-600",
    text: "We are so lucky to have found Artemios. Not only is he a great trainer, he's a great person and role model for our son. He takes the time to get to know his players, identify strengths and weaknesses and work on both the physical skills and mind set.",
  },
  {
    name: "Chris Katerinakis",
    color: "bg-teal-600",
    text: "Artemios has completely changed my relationship with basketball. I started as someone who struggled just to handle the ball confidently, and through his coaching, I've developed the skills and confidence to soon play in a men's pickup league. What I appreciate most is that he never just taught basketball skills. He taught me how to believe in my ability to improve. Watching him coach other athletes has only increased my respect for him. His skill level as a player is obvious, but what truly stands out is his ability to communicate, motivate, and connect with each athlete. I'm incredibly thankful for everything he's invested in me and would recommend Mesa Basketball Training, especially for athletes looking to take their game to the next level.",
  },
  {
    name: "Rex Espineli",
    color: "bg-purple-600",
    text: "Coach A brings professional basketball experience to guide young athletes on their basketball journey building skills & confidence.",
  },
];

export default function Testimonials() {
  const [index, setIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);

  function goTo(i: number) {
    setIndex(((i % testimonials.length) + testimonials.length) % testimonials.length);
  }

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (delta > 40) goTo(index - 1);
    else if (delta < -40) goTo(index + 1);
    touchStartX.current = null;
  }

  const t = testimonials[index];
  const initial = t.name.charAt(0);

  const dots = (
    <div className="flex justify-center gap-2">
      {testimonials.map((_, i) => (
        <button
          key={i}
          onClick={() => goTo(i)}
          aria-label={`Go to review ${i + 1}`}
          className={`h-2 rounded-full transition-all ${i === index ? "w-6 bg-mesa-accent" : "w-2 bg-brown-600 hover:bg-brown-500"}`}
        />
      ))}
    </div>
  );

  return (
    <section className="relative bg-gradient-to-b from-brown-900 via-mesa-dark to-brown-900 border-y border-mesa-accent/30 py-16 md:py-24 overflow-hidden">
      {/* Decorative giant quote mark */}
      <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 text-[11rem] md:text-[18rem] font-black text-mesa-accent/10 leading-none select-none font-serif">
        &rdquo;
      </span>

      <div className="relative mx-auto max-w-3xl px-6">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-mesa-accent/40 bg-mesa-accent/10 px-4 py-1.5 mb-4">
            <span className="text-mesa-accent text-sm tracking-tight">★★★★★</span>
            <span className="text-xs font-semibold uppercase tracking-widest text-mesa-accent">5.0 on Google</span>
          </div>
          <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl md:text-5xl font-black tracking-wide">
            WHAT FAMILIES ARE SAYING
          </h2>
        </div>

        {/* Card — arrows are desktop-only overlays; mobile gets its own nav row below the quote so nothing sits on top of the text */}
        <div
          className="relative rounded-2xl border-2 border-mesa-accent/40 bg-brown-900/60 px-6 py-8 md:px-20 md:py-12 shadow-2xl shadow-black/40 select-none"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <button
            onClick={() => goTo(index - 1)}
            aria-label="Previous review"
            className="hidden md:flex absolute left-4 top-1/2 -translate-y-1/2 h-10 w-10 items-center justify-center rounded-full border border-mesa-accent/50 text-mesa-accent hover:bg-mesa-accent hover:text-white transition text-xl"
          >
            &lsaquo;
          </button>
          <button
            onClick={() => goTo(index + 1)}
            aria-label="Next review"
            className="hidden md:flex absolute right-4 top-1/2 -translate-y-1/2 h-10 w-10 items-center justify-center rounded-full border border-mesa-accent/50 text-mesa-accent hover:bg-mesa-accent hover:text-white transition text-xl"
          >
            &rsaquo;
          </button>

          <div className="flex flex-col items-center">
            <div className={`h-12 w-12 shrink-0 rounded-full ${t.color} flex items-center justify-center text-white font-bold text-lg mb-4`}>
              {initial}
            </div>
            <div className="text-mesa-accent text-lg mb-4 tracking-tight">★★★★★</div>
            <blockquote className="text-center text-brown-100 text-base md:text-lg leading-relaxed italic min-h-[10rem] md:min-h-[6rem] flex items-center">
              <span>&ldquo;{t.text}&rdquo;</span>
            </blockquote>
            <p className="mt-6 text-mesa-accent font-semibold text-sm uppercase tracking-widest text-center">{t.name}</p>
          </div>

          {/* Mobile nav: prev / dots / next in normal flow, never overlapping the quote */}
          <div className="mt-8 flex items-center justify-center gap-5 md:hidden">
            <button onClick={() => goTo(index - 1)} aria-label="Previous review" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-mesa-accent/50 text-mesa-accent text-xl">
              &lsaquo;
            </button>
            {dots}
            <button onClick={() => goTo(index + 1)} aria-label="Next review" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-mesa-accent/50 text-mesa-accent text-xl">
              &rsaquo;
            </button>
          </div>

          <div className="mt-8 hidden md:block">{dots}</div>
        </div>

        <div className="mt-6 text-center">
          <a
            href={GOOGLE_REVIEWS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-mesa-accent hover:text-yellow-400 transition"
          >
            Read more reviews on Google &rarr;
          </a>
        </div>
      </div>
    </section>
  );
}
