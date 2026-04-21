import type { Metadata } from "next";
import LandingNav from "../LandingNav";

export const metadata: Metadata = {
  title: "Privacy Policy | Mesa Basketball Training",
  description:
    "Mesa Basketball Training LLC privacy policy — how we collect, use, and protect your information.",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      <LandingNav />

      <main className="mx-auto max-w-3xl px-6 py-16 md:py-24">
        <h1 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide text-mesa-accent mb-12">
          PRIVACY POLICY
        </h1>

        <div className="space-y-12 text-brown-200 leading-relaxed text-[16px]">

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              1. OVERVIEW
            </h2>
            <p>
              Mesa Basketball Training LLC (&ldquo;Mesa,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) is committed to
              protecting the privacy of our clients and their families. This Privacy Policy explains what
              personal information we collect, how we use it, and your rights regarding that information.
              By registering for any Mesa program or providing us with your contact details, you agree to
              the practices described in this policy.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              2. INFORMATION WE COLLECT
            </h2>
            <p className="mb-4">
              When you register for a session, camp, or private training program, we may collect the
              following information:
            </p>
            <ul className="list-disc list-inside space-y-2 text-brown-300 ml-2">
              <li>Parent or guardian name</li>
              <li>Email address</li>
              <li>Phone number (including mobile number for SMS communications)</li>
              <li>Athlete&apos;s name and age group</li>
              <li>Session or program selections and booking history</li>
            </ul>
            <p className="mt-4">
              We collect this information directly from you when you complete a registration form on our
              website or communicate with us by phone, text, or email.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              3. HOW WE USE YOUR INFORMATION
            </h2>
            <p className="mb-4">
              We use the information we collect solely for the purposes of operating our training programs:
            </p>
            <ul className="list-disc list-inside space-y-2 text-brown-300 ml-2">
              <li>Processing and confirming session registrations and bookings</li>
              <li>Sending booking confirmations and program updates via email</li>
              <li>Sending SMS reminders about upcoming sessions and schedule changes</li>
              <li>Managing cancellations, reschedules, and waitlists</li>
              <li>Responding to questions or support requests</li>
              <li>Maintaining records for our referral and loyalty programs</li>
            </ul>
            <p className="mt-4">
              We do not use your personal information for automated decision-making or profiling.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              4. SMS COMMUNICATIONS
            </h2>
            <p className="mb-4">
              During registration on mesabasketballtraining.com, you are presented with a required opt-in
              checkbox before your registration can be submitted. By checking that box, you explicitly
              consent to receive SMS text messages from Mesa Basketball Training LLC. The checkbox is
              unchecked by default and no SMS messages are sent unless you check it. These messages may include:
            </p>
            <ul className="list-disc list-inside space-y-2 text-brown-300 ml-2">
              <li>Booking confirmations</li>
              <li>Session reminders (typically sent the day before a scheduled session)</li>
              <li>Schedule updates, cancellations, or weather-related notices</li>
              <li>Program announcements and new session availability</li>
            </ul>
            <p className="mt-4">
              <span className="text-white font-semibold">Message frequency:</span> Approximately weekly,
              varying with active registrations and program announcements.
            </p>
            <p className="mt-3">
              <span className="text-white font-semibold">To opt out:</span> Reply <span className="text-mesa-accent font-semibold">STOP</span> to
              any SMS message at any time to unsubscribe. You will receive a one-time confirmation and no
              further messages will be sent. To re-subscribe, reply <span className="text-mesa-accent font-semibold">START</span>.
            </p>
            <p className="mt-3">
              <span className="text-white font-semibold">For help:</span> Reply <span className="text-mesa-accent font-semibold">HELP</span> or
              contact us at{" "}
              <a href="mailto:artemios@mesabasketballtraining.com" className="text-mesa-accent hover:text-yellow-300 underline">
                artemios@mesabasketballtraining.com
              </a>.
            </p>
            <p className="mt-3 text-brown-400 text-sm">
              Msg &amp; data rates may apply. Mesa Basketball Training LLC is not responsible for any
              fees charged by your mobile carrier.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              5. SHARING OF INFORMATION
            </h2>
            <p className="mb-4">
              We do not sell, rent, or share your personal information with third parties for marketing
              purposes. We may share your information only in the following limited circumstances:
            </p>
            <ul className="list-disc list-inside space-y-2 text-brown-300 ml-2">
              <li>
                <span className="text-white">Service providers:</span> We use trusted third-party platforms
                (including Supabase for data storage, Resend for email delivery, and SMS messaging services)
                solely to operate our booking and communication systems. These providers are contractually
                prohibited from using your data for any other purpose.
              </li>
              <li>
                <span className="text-white">Legal requirements:</span> We may disclose information if
                required by law or in response to a valid legal process.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              6. DATA RETENTION
            </h2>
            <p>
              We retain your information for as long as necessary to provide our services and maintain
              booking records. If you would like your personal information deleted, please contact us at
              the email address below and we will fulfill your request within a reasonable timeframe,
              subject to any legal obligations to retain records.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              7. SECURITY
            </h2>
            <p>
              We take reasonable measures to protect your personal information from unauthorized access,
              disclosure, or misuse. Our booking data is stored in a secure cloud database with access
              restricted to authorized personnel only. However, no method of transmission over the
              internet or electronic storage is completely secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              8. CHILDREN&apos;S PRIVACY
            </h2>
            <p>
              Our services are directed toward families, and we frequently collect information about
              minor athletes. All registration and consent is handled through a parent or guardian.
              We do not knowingly collect personal information directly from children under the age of
              13 without parental consent. If you believe we have inadvertently received such information,
              please contact us and we will promptly delete it.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              9. CHANGES TO THIS POLICY
            </h2>
            <p>
              We may update this Privacy Policy from time to time. When we do, we will post the revised
              policy on this page with an updated effective date. We encourage you to review this policy
              periodically.
            </p>
          </section>

          <section>
            <h2 className="font-[family-name:var(--font-fira-cond)] text-2xl font-black tracking-wide text-white mb-4">
              10. CONTACT US
            </h2>
            <p className="mb-4">
              If you have any questions about this Privacy Policy or how we handle your information,
              please reach out:
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
