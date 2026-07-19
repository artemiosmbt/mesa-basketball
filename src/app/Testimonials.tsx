"use client";

import { useEffect, useRef, useState } from "react";

const GOOGLE_REVIEWS_URL = "https://share.google/ar2S4cjDrW5cx7wbc";
const AUTO_ADVANCE_MS = 5000;

interface Testimonial {
  name: string;
  text: string;
}

const testimonials: Testimonial[] = [
  {
    name: "Dianna Kazakis",
    text: "For over a year, both of my children—a 14-year-old son and a 12-year-old daughter—have trained with Coach Artemios. During that time, their skills, confidence, and love for the game have grown tremendously. Coach Artemios tailors each lesson to the individual player's level, helping them develop both technically and mentally. I've watched my children go from players with limited experience to key contributors on their teams. His dedication, patience, and ability to bring out the best in each athlete have made a tremendous impact. We are so grateful for everything he has done and highly recommend him to any player looking to improve their game.",
  },
  {
    name: "Daniel O'Connell",
    text: "We are so lucky to have found Artemios. Not only is he a great trainer, he's a great person and role model for our son. He takes the time to get to know his players, identify strengths and weaknesses and work on both the physical skills and mind set.",
  },
  {
    name: "Rex Espineli",
    text: "Coach A brings professional basketball experience to guide young athletes on their basketball journey building skills & confidence.",
  },
  {
    name: "Chris Katerinakis",
    text: "Artemios has completely changed my relationship with basketball. I started as someone who struggled just to handle the ball confidently, and through his coaching, I've developed the skills and confidence to soon play in a men's pickup league. What I appreciate most is that he never just taught basketball skills. He taught me how to believe in my ability to improve. Watching him coach other athletes has only increased my respect for him. His skill level as a player is obvious, but what truly stands out is his ability to communicate, motivate, and connect with each athlete. I'm incredibly thankful for everything he's invested in me and would recommend Mesa Basketball Training, especially for athletes looking to take their game to the next level.",
  },
];

export default function Testimonials() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % testimonials.length);
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(timer);
    // Reset the timer whenever the slide changes (auto or manual) so a swipe
    // or arrow click doesn't get cut short by an advance a moment later.
  }, [paused, index]);

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

  return (
    <section className="bg-brown-950 border-t border-brown-800 py-16 md:py-24">
      <div className="mx-auto max-w-3xl px-6">
        <div className="text-center mb-10">
          <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-2">What Families Say</p>
          <h2 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide">REAL RESULTS. REAL FAMILIES.</h2>
        </div>

        <div
          className="relative rounded-2xl border border-brown-700 bg-brown-900/40 px-6 py-10 md:px-16 md:py-12 select-none"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <button
            onClick={() => goTo(index - 1)}
            aria-label="Previous review"
            className="absolute left-2 md:left-3 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full border border-brown-600 text-brown-300 hover:text-white hover:border-mesa-accent transition"
          >
            &lsaquo;
          </button>
          <button
            onClick={() => goTo(index + 1)}
            aria-label="Next review"
            className="absolute right-2 md:right-3 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full border border-brown-600 text-brown-300 hover:text-white hover:border-mesa-accent transition"
          >
            &rsaquo;
          </button>

          <div className="flex justify-center gap-1 mb-5 text-mesa-accent text-lg" aria-label="5 out of 5 stars">
            {"★★★★★"}
          </div>

          <blockquote className="text-center text-brown-200 text-base md:text-lg leading-relaxed italic min-h-[9rem] md:min-h-[7rem] flex items-center justify-center">
            <span>&ldquo;{t.text}&rdquo;</span>
          </blockquote>

          <p className="mt-6 text-center text-mesa-accent font-semibold text-sm uppercase tracking-widest">
            {t.name}
          </p>

          <div className="mt-6 flex justify-center gap-2">
            {testimonials.map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                aria-label={`Go to review ${i + 1}`}
                className={`h-2 rounded-full transition-all ${i === index ? "w-6 bg-mesa-accent" : "w-2 bg-brown-600 hover:bg-brown-500"}`}
              />
            ))}
          </div>
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
