import type { Metadata } from "next";
import {
  CONTACT_EMAIL,
  LegalPage,
  LegalSection,
  legalStyles as styles,
} from "@/features/onboarding/legal-page";

export const metadata: Metadata = {
  title: "Contact",
  description: "Reach the H3 Max Realtime Education team.",
};

export default function ContactPage() {
  return (
    <LegalPage title="Contact" updated="August 2026">
      <LegalSection heading="Email us">
        <p className={styles.legalBody}>
          The fastest way to reach the H3 Max Realtime Education team is email:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. We read everything and aim
          to reply within two school days.
        </p>
      </LegalSection>

      <LegalSection heading="What to include">
        <ul className={styles.legalList}>
          <li>Learners and parents: the topic you were studying and what happened.</li>
          <li>Teachers: your school and how you would like to use H3 Max Realtime Education.</li>
          <li>Privacy requests: see our privacy page for what we can delete or export.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="Safety concerns">
        <p className={styles.legalBody}>
          If something in a lesson felt wrong or unsafe, tell us at{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with the word
          &ldquo;safety&rdquo; in the subject line and we will prioritize it.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
