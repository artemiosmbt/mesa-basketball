import type { Metadata } from "next";
import LandingNav from "../LandingNav";

export const metadata: Metadata = {
  title: "Terms & Conditions | Mesa Basketball Training",
  description:
    "Mesa Basketball Training LLC terms and conditions — program policies, SMS messaging terms, payments, and liability.",
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      <LandingNav />

      <main className="mx-auto max-w-3xl px-6 py-16 md:py-24">
        <h1 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide text-mesa-accent mb-12">
          TERMS &amp; CONDITIONS
        </h1>

        <div className="space-y-12 text-brown-200 leading-relaxed text-[16px]">

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              1. ACCEPTANCE OF TERMS
            </h2>
            <p>
              By registering for any program, session, or service offered by Mesa Basketball Training LLC
              (&ldquo;Mesa,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;), you (&ldquo;Client&rdquo;) agree to be bound by these Terms and
              Conditions. If you are registering on behalf of a minor, you represent that you are the
              parent or legal guardian of that minor and accept these terms on their behalf. Please read
              these terms carefully before completing a registration.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              2. PROGRAM DESCRIPTION
            </h2>
            <p className="mb-4">
              Mesa Basketball Training LLC provides basketball skill development and training programs on
              Long Island, New York. Our offerings include:
            </p>
            <ul className="list-disc list-inside space-y-2 text-brown-300 ml-2">
              <li>
                <span className="text-white">Group Sessions</span> &mdash; skill-based training in small
                groups organized by age and ability level
              </li>
              <li>
                <span className="text-white">Mini Camps</span> &mdash; multi-day intensive training programs
              </li>
              <li>
                <span className="text-white">Private Training</span> &mdash; one-on-one sessions tailored
                to the individual athlete
              </li>
            </ul>
            <p className="mt-4">
              All programs are led by or under the direct supervision of Artemios Gavalas, a former
              Division I and professional basketball player with over five years of training experience.
              Mesa reserves the right to modify program content, locations, or formats as circumstances require.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              3. REGISTRATION &amp; ENROLLMENT
            </h2>
            <p className="mb-4">
              Registration is confirmed upon receipt of full payment. Enrollment is subject to available
              capacity. Mesa reserves the right to cancel or limit enrollment in any program. In the event
              Mesa cancels a program, registered clients will receive a full refund or credit toward a
              future session at their discretion.
            </p>
            <p>
              Clients are responsible for providing accurate contact and athlete information at the time
              of registration. Inaccurate information may affect your ability to receive session reminders
              and booking confirmations.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              4. SMS MESSAGING TERMS
            </h2>
            <p className="mb-4">
              During registration on mesabasketballtraining.com, you are presented with an optional SMS
              opt-in checkbox. Checking that box is voluntary — it is unchecked by default and is not
              required to complete your registration. By checking it, you explicitly consent to receive
              SMS text messages from Mesa Basketball Training LLC.
            </p>
            <div className="rounded-lg border border-brown-700 bg-brown-900/40 px-6 py-5 space-y-3 text-brown-300">
              <p>
                <span className="text-white font-semibold">Program name:</span> Mesa Basketball Training
              </p>
              <p>
                <span className="text-white font-semibold">Message types:</span> Booking confirmations,
                session reminders, schedule updates, and program announcements
              </p>
              <p>
                <span className="text-white font-semibold">Message frequency:</span> Message frequency
                varies. Approximately weekly based on active registrations and program activity.
              </p>
              <p>
                <span className="text-white font-semibold">Msg &amp; data rates:</span> Message and
                data rates may apply.
              </p>
              <p>
                <strong className="text-white">To opt out: Reply STOP</strong> at any time to unsubscribe
                from all SMS messages. You will receive a single confirmation and no further messages will
                be sent.
              </p>
              <p>
                <strong className="text-white">For help: Reply HELP</strong> or contact us at{" "}
                <a href="mailto:artemios@mesabasketballtraining.com" className="text-mesa-accent hover:text-yellow-300 underline">
                  artemios@mesabasketballtraining.com
                </a>{" "}or call (631) 599-1280.
              </p>
              <p>
                <span className="text-white font-semibold">Carrier disclaimer:</span> Carriers are not
                liable for any delayed or undelivered messages.
              </p>
              <p>
                <a href="/privacy-policy" className="text-mesa-accent hover:text-yellow-300 underline">
                  Privacy Policy
                </a>
              </p>
            </div>
            <p className="mt-4">
              Opting out of SMS messages does not cancel your registration. To cancel a booking, please
              use the cancellation link in your booking confirmation email or contact us directly.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              5. PAYMENTS &amp; REFUND POLICY
            </h2>
            <p className="mb-4">
              All session fees are due at the time of registration. Accepted payment methods are listed
              at checkout. The following refund policy applies:
            </p>
            <ul className="list-disc list-inside space-y-2 text-brown-300 ml-2">
              <li>
                <span className="text-white">Cancellations made 48+ hours in advance</span> are eligible
                for a full credit toward a future session of equal value.
              </li>
              <li>
                <span className="text-white">Cancellations made less than 48 hours in advance</span> are
                generally non-refundable. Exceptions may be made at Mesa&apos;s sole discretion in cases of
                illness or emergency.
              </li>
              <li>
                <span className="text-white">No-shows</span> without prior notice will be charged the <strong className="text-white">full session fee</strong> (not a partial fee — the complete amount).
              </li>
              <li>
                <span className="text-white">Mesa-initiated cancellations</span> (e.g., weather, facility
                issues) will be rescheduled or refunded in full.
              </li>
            </ul>
            <p className="mt-4">
              Refund requests and cancellations can be submitted via the link in your booking confirmation
              email or by contacting us directly.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              6. CODE OF CONDUCT
            </h2>
            <p>
              All participants are expected to conduct themselves in a respectful and sportsmanlike manner
              toward coaches, fellow athletes, and facility staff. Mesa reserves the right to remove any
              participant from a session or program — without refund — for conduct that is disruptive,
              disrespectful, or unsafe to others.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              7. LIABILITY WAIVER
            </h2>
            <p className="mb-4">
              Participation in basketball training involves physical activity and inherent risk of injury.
              By registering, you acknowledge and agree that:
            </p>
            <ul className="list-disc list-inside space-y-2 text-brown-300 ml-2">
              <li>
                You voluntarily assume all risks associated with participation, including but not limited
                to sprains, strains, fractures, or other injuries.
              </li>
              <li>
                Mesa Basketball Training LLC, its staff, and affiliated coaches are not liable for any
                injury, loss, or damage arising from participation in any program.
              </li>
              <li>
                You represent that the registered athlete is physically fit to participate and that any
                known medical conditions have been disclosed to the trainer prior to the session.
              </li>
            </ul>
            <p className="mt-4">
              This waiver does not limit liability for gross negligence or willful misconduct.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              8. PHOTO &amp; MEDIA RELEASE
            </h2>
            <p>
              Mesa Basketball Training LLC may photograph or record training sessions for use in
              promotional materials, including social media. By registering, you grant Mesa a
              non-exclusive license to use photos or videos in which the registered athlete may appear,
              without compensation. If you do not consent to this, please notify us in writing prior to
              your first session.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              9. GOVERNING LAW
            </h2>
            <p>
              These Terms and Conditions are governed by the laws of the State of New York. Any disputes
              arising under these terms shall be resolved in the courts of Suffolk County, New York.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              10. CHANGES TO THESE TERMS
            </h2>
            <p>
              Mesa reserves the right to update these Terms and Conditions at any time. The most current
              version will always be available at{" "}
              <a href="/terms" className="text-mesa-accent hover:text-yellow-300 underline">
                mesabasketballtraining.com/terms
              </a>
              . Continued participation in any Mesa program following an update constitutes acceptance of
              the revised terms.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              11. CONTACT US
            </h2>
            <p className="mb-4">
              Questions about these terms? We&apos;re easy to reach:
            </p>
            <div className="rounded-lg border border-brown-700 bg-brown-900/40 px-6 py-5 space-y-2 text-brown-300">
              <p className="text-white font-semibold">Mesa Basketball Training LLC</p>
              <p>
                Email:{" "}
                <a href="mailto:artemios@mesabasketballtraining.com" className="text-mesa-accent hover:text-yellow-300">
                  artemios@mesabasketballtraining.com
                </a>
              </p>
              <p>
                Phone:{" "}
                <a href="tel:6315991280" className="text-mesa-accent hover:text-yellow-300">
                  (631) 599-1280
                </a>
              </p>
              <p>Long Island, New York</p>
            </div>
          </section>

        </div>

        <p className="text-brown-400 text-sm mt-12">
          Mesa Basketball Training LLC &mdash; Last updated April 2026
        </p>
      </main>

      <footer className="border-t border-brown-800 bg-mesa-dark py-10">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <p className="text-sm text-brown-600">
            &copy; 2025&ndash;{new Date().getFullYear()} Mesa Basketball Training LLC. All rights reserved.
          </p>
          <div className="mt-2 flex justify-center gap-6 text-sm text-brown-500">
            <a href="/privacy-policy" className="hover:text-mesa-accent">Privacy Policy</a>
            <a href="/terms" className="hover:text-mesa-accent">Terms &amp; Conditions</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
