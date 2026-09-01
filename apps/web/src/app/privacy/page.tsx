import type { Metadata } from "next";
import {
  CONTACT_EMAIL,
  LegalPage,
  LegalSection,
  legalStyles as styles,
} from "@/features/onboarding/legal-page";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How H3 Max Realtime Education collects, uses, and protects learner data.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="August 2026">
      <LegalSection heading="What we collect">
        <p className={styles.legalBody}>
          H3 Max Realtime Education is built for learners aged 13–18, so we collect only what a lesson needs:
        </p>
        <ul className={styles.legalList}>
          <li>
            Voice audio streamed while the mic is unmuted, until you mute or end the session,
            transcribed to power the conversation.
          </li>
          <li>Typed questions and answers during a session.</li>
          <li>
            An essential session cookie that keeps you signed in, which expires after 7 days.
          </li>
          <li>
            Hashed network data used only to admit sessions and prevent abuse — never tied to
            lesson content.
          </li>
          <li>Content-free metrics and logs (timings, errors) that keep the service running.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="What we keep">
        <p className={styles.legalBody}>
          Raw transcripts are kept for at most 24 hours and are cleared when you close a
          session. What stays longer is compact learning memory:
        </p>
        <ul className={styles.legalList}>
          <li>Mastery progress and the evidence behind it.</li>
          <li>Misconceptions the tutor is helping you work through.</li>
          <li>Your preferences and interests, so explanations fit you.</li>
          <li>Compact summaries of past sessions.</li>
          <li>
            Exploration history and card/visual metadata (which visuals were generated and
            shown — not the raw conversation).
          </li>
        </ul>
        <p className={styles.legalBody}>
          This profile is kept while your account is active so the tutor can pick up where you
          left off. Operational logs are kept only as long as needed to run and secure the
          service.
        </p>
      </LegalSection>

      <LegalSection heading="Who processes it">
        <p className={styles.legalBody}>
          fal and xAI process voice audio and live voice transcripts to run the spoken tutor.
          fal also processes compiled visual prompts (descriptions of the concept to draw — not
          your conversation) to generate visualizations. Data is sent over encrypted connections.
        </p>
      </LegalSection>

      <LegalSection heading="How we use it">
        <p className={styles.legalBody}>
          Session content is used only to teach you: generating explanations, drawing
          visualizations, and updating your mastery map. We do not sell learner data, show
          advertising, or build profiles for marketing.
        </p>
      </LegalSection>

      <LegalSection heading="Your controls">
        <p className={styles.legalBody}>
          You can mute the mic or end a session at any time. Questions about your data? Email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
