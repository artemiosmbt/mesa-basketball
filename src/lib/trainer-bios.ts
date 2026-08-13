// The site's growing roster of sub-trainers (everyone besides Artemios,
// whose own founder-specific bio/career sections on /about are hand-built,
// not data-driven). Add a new entry here for each trainer as they're brought
// on. Array order below is the exact display order on the About page (and
// the nav dropdown that links into it) — deliberately curated, not sorted,
// so it doesn't need to be alphabetical.
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
      "Joe is a dedicated basketball trainer whose passion for player development was sparked early, shifting his focus to coaching and skill work after injuries redirected his path. A former point guard and four-year varsity player at Amityville Memorial High School, Joe brings a player's perspective to every session he leads.",
      "Joe has trained athletes of all ages and skill levels, with a track record that includes developing Division I and professional players. Among those he has worked with is Zakai Zeigler, the standout Tennessee point guard and two-time SEC Defensive Player of the Year who holds the Tennessee career assists record. Joe has also gained experience working with Hoop Group Camps, developing high-level talent in a competitive setting alongside some of the top players in the region.",
      "His ability to connect with athletes, identify areas for growth, and deliver results-driven training makes Joe a valuable asset to any player looking to take their game to the next level. His commitment to the craft and genuine investment in each athlete's development set him apart as a trainer.",
    ],
  },
  {
    slug: "zhaneia-thybulle",
    displayName: "Coach Z Thybulle",
    title: "Coach",
    headshot: "/headshot-zhaneia-thybulle.jpg",
    headshotPosition: "center",
    pills: ["Adelphi University Coach", "UNC Wilmington & Wagner College", "Elmont Memorial Alum"],
    photos: [
      "/zhaneia-thybulle-action.jpg",
      "/zhaneia-thybulle-coaching.jpg",
      "/zhaneia-thybulle-sideline.jpg",
      "/zhaneia-thybulle-clinic.jpg",
    ],
    bioParagraphs: [
      "Zhaneia \"Z\" Thybulle is a college basketball coach and player development specialist. A Long Island native and Elmont Memorial basketball standout, Coach Z built her playing career at the Division I level, competing at both UNC Wilmington and Wagner College. During her time at Wagner, she became a key contributor and leader for the program.",
      "After her playing career, Coach Z transitioned into coaching, bringing her experience as a point guard, competitor, and leader into player development. Going into her 4th year coaching at both the D1 and D2 level, Coach Z continues to focus on player development, relationship building, and creating an environment where athletes are challenged to grow every day.",
      "Coach Z believes great coaching starts with relationships. Her goal is to challenge athletes, build confidence, develop discipline, and give players the tools to become better basketball players, teammates, leaders, and people.",
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
  {
    slug: "zain-amjad",
    displayName: "Zain Amjad",
    title: "Trainer",
    headshot: "/headshot-zain-amjad.jpg",
    headshotPosition: "center",
    pills: ["AAU Head Coach", "Youth Through Collegiate Levels"],
    photos: ["/zain-amjad-action.jpg"],
    bioParagraphs: [
      "Zain is a dedicated basketball trainer and coach with a passion for helping players develop their skills, confidence, and overall understanding of the game. Having experienced the game as both a player and coach, he understands that real development goes beyond simply running through drills. His approach is centered around purposeful training, attention to detail, and teaching players how to translate the skills they develop in workouts into real game situations.",
      "Through his experience coaching with Rising Stars Youth Foundation, including serving as an AAU head coach, Zain has had the opportunity to work with athletes across a wide range of ages and skill levels. He has trained players from youth basketball through the high school and collegiate levels, allowing him to understand how to adjust his approach to each athlete's individual needs. His training emphasizes ball handling, footwork, finishing, shooting, change of pace, decision-making, basketball IQ, and the physical tools necessary to become a more complete player.",
      "What sets Zain apart is his ability to build a genuine connection with every athlete he works with. He believes players should understand not only how to perform a skill, but why and when to use it. He creates a positive but competitive environment where players are encouraged to work hard, make mistakes, learn, and build confidence in their abilities. His goal with every session is simple — help each player leave the gym better than they came in.",
    ],
  },
];

// Strips a leading "Coach " (e.g. "Coach Z Thybulle") before taking the
// first word — used for the "About Coach X" bio subtitle on the About page,
// so it reads by the trainer's actual first name rather than the literal
// word "Coach".
export function trainerFirstName(fullName: string): string {
  const name = fullName.trim().replace(/^coach\s+/i, "");
  const parts = name.trim().split(/\s+/);
  return parts[0] || fullName;
}

// Kept as its own export (rather than using TRAINERS directly everywhere)
// since callers historically read the roster through this name — it's just
// TRAINERS in its already-curated display order now, no sorting applied.
export const sortedTrainers = TRAINERS;

// The About nav dropdown stays two items — founder, then a single "Meet
// the Team" link into the trainer roster section — rather than listing
// every trainer by name, which would grow unwieldy as the roster does.
// Individual trainers are still reachable by scrolling (or via their own
// "Show Bio" link on the schedule page, see TRAINER_BIO_SLUGS).
export const ABOUT_PAGE_ROSTER: { displayName: string; slug: string }[] = [
  { displayName: "Artemios Gavalas", slug: "artemios-gavalas" },
  ...(sortedTrainers.length > 0 ? [{ displayName: "Meet the Team", slug: "meet-the-team" }] : []),
];
