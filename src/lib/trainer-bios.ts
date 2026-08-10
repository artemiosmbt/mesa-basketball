// The site's growing roster of sub-trainers (everyone besides Artemios,
// whose own founder-specific bio/career sections on /about are hand-built,
// not data-driven). Add a new entry here for each trainer as they're brought
// on — sorted below by last name so the About page (and the nav dropdown
// that links into it) stay in alphabetical order automatically as the
// roster grows, matching how the admin dashboard's Groups tab already sorts
// athletes for the same reason.
export interface TrainerBio {
  slug: string; // must match the corresponding key in TRAINER_BIO_SLUGS (src/lib/trainers.ts)
  displayName: string; // may differ from the exact schedule-data name (e.g. a nickname)
  title: string;
  headshot: string;
  headshotPosition?: string; // CSS object-position; defaults to center
  pills: string[]; // credential/highlight pills shown under the name, matching Artemios's hero
  bioParagraphs: string[];
  // A trainer has either a video OR a set of photos alongside their bio
  // (never both) — the About page layout only splits into a side-by-side
  // row when one of these is present, so a bio reads cleanly full-width
  // otherwise. videoUrl takes priority if somehow both are set.
  videoUrl?: string;
  photos?: string[];
}

export const TRAINERS: TrainerBio[] = [
  {
    slug: "joe-owens",
    displayName: "Joe Owens",
    title: "Trainer",
    headshot: "/headshot-joe-owens.jpg",
    headshotPosition: "center",
    pills: ["5+ Year Trainer", "All Ages Experience"],
    videoUrl: "/joe-owens-workout-reel.mp4",
    bioParagraphs: [
      "I am a dedicated basketball skills trainer passionate about helping athletes reach their full potential through skill development, basketball IQ, and confidence. I began my coaching career early after injuries shifted my focus to player development.",
      "I played four years of varsity basketball at Amityville Memorial High School and have trained athletes of all ages and skill levels, including developing Division I and professional athletes. I have also worked with Hoop Group Camps, gaining experience in developing high-level talent in a competitive environment.",
    ],
  },
  {
    slug: "steven-papadimitropoulos",
    displayName: "Steven Papadimitropoulos",
    title: "Trainer",
    headshot: "/headshot-steven-papadimitropoulos.jpg",
    headshotPosition: "center",
    pills: ["4+ Year Trainer", "St. John's University", "Long Island Lutheran Alum"],
    photos: ["/steven-papadimitropoulos-sideline.jpg", "/steven-papadimitropoulos-practice.jpg"],
    bioParagraphs: [
      "Steven is a dedicated basketball trainer with four years of coaching experience at Hoop Lab, where he has worked with athletes of all ages and skill levels to develop their game. His ability to connect with players at every stage of development has made him a versatile and reliable trainer for athletes looking to improve.",
      "Steven also brings four years of experience working within the women's basketball program at St. John's University. Being immersed in a Division I environment gave Steven an inside look at elite player development, high-level preparation, and the competitive standards that separate good players from great ones. From film study and scouting to on-court workouts and skill development, Steven was involved in all aspects of what it takes to prepare athletes to compete at the highest level. That experience shapes every session he runs, bringing a collegiate level of detail and intensity to every athlete he works with.",
      "As a former varsity player at Long Island Lutheran High School, Steven combines firsthand playing experience with years of coaching and training expertise. His passion for teaching, attention to detail, and commitment to helping players improve make him a trusted mentor for athletes looking to elevate their skills, confidence, and understanding of the game.",
    ],
  },
];

export function trainerLastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

export const sortedTrainers = [...TRAINERS].sort((a, b) =>
  trainerLastName(a.displayName).localeCompare(trainerLastName(b.displayName))
);

// Founder always leads the nav dropdown (matching his fixed position at the
// top of the About page itself, ahead of the alphabetically-sorted
// sub-trainers below him) rather than being sorted in with everyone else.
export const ABOUT_PAGE_ROSTER: { displayName: string; slug: string }[] = [
  { displayName: "Artemios Gavalas", slug: "artemios-gavalas" },
  ...sortedTrainers.map((t) => ({ displayName: t.displayName, slug: t.slug })),
];
