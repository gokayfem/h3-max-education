import type { Metadata } from "next";
import {
  CONTACT_EMAIL,
  LegalPage,
  LegalSection,
  legalStyles as styles,
} from "@/features/onboarding/legal-page";

export const metadata: Metadata = {
  title: "Careers",
  description: "Work on the H3 Max Realtime Education science companion.",
};

export default function CareersPage() {
  return (
    <LegalPage title="Careers" updated="August 2026">
      <LegalSection heading="Open roles">
        <p className={styles.legalBody}>
          We are a small team and are not hiring for specific roles right now. That is the
          honest answer — we would rather say so than post listings we are not filling.
        </p>
      </LegalSection>

      <LegalSection heading="Introduce yourself">
        <p className={styles.legalBody}>
          If you care about science education, calm software, and building for teenagers, we
          still want to hear from you. Write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with what you have built and
          what you would want to work on, and we will reach out when a fitting role opens.
        </p>
      </LegalSection>

      <LegalSection heading="How we work">
        <ul className={styles.legalList}>
          <li>Small, senior team; few meetings, long focus blocks.</li>
          <li>Correctness and learner safety before shipping speed.</li>
          <li>Remote-friendly, with writing over slides.</li>
        </ul>
      </LegalSection>
    </LegalPage>
  );
}
