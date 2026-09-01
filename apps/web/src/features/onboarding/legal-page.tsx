import Link from "next/link";
import type { ReactNode } from "react";
import styles from "@/features/onboarding/onboarding.module.css";

export const CONTACT_EMAIL = "hello@axiomlearning.com";

interface LegalPageProps {
  readonly title: string;
  readonly updated: string;
  readonly children: ReactNode;
}

export function LegalPage({ title, updated, children }: LegalPageProps) {
  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <div className={styles.legalNavInner}>
          <Link href="/" className={styles.wordmark} aria-label="H3 Max Realtime Education home">
            H3 Max Realtime Education
            <span className={styles.brandDot} aria-hidden="true" />
          </Link>
          <Link href="/" className={styles.navLink}>
            Back to home
          </Link>
        </div>
      </header>

      <main id="main" className={styles.legalMain}>
        <div className={styles.legalInner}>
          <h1 className={styles.legalTitle}>{title}</h1>
          <p className={styles.legalUpdated}>Last updated {updated}</p>
          {children}
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerTop}>
            <div>
              <span className={styles.footerWordmark}>
                H3 Max Realtime Education
                <span className={styles.brandDot} aria-hidden="true" />
              </span>
              <p className={styles.footerTagline}>Science that answers back.</p>
            </div>
            <nav className={styles.footerLinks} aria-label="Footer">
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
              <Link href="/contact">Contact</Link>
              <Link href="/careers">Careers</Link>
            </nav>
          </div>
          <div className={styles.footerBottom}>
            <p>© 2026 H3 Max Realtime Education. Built for curious minds aged 13–18.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

interface LegalSectionProps {
  readonly heading: string;
  readonly children: ReactNode;
}

export function LegalSection({ heading, children }: LegalSectionProps) {
  return (
    <section className={styles.legalSection}>
      <h2 className={styles.legalHeading}>{heading}</h2>
      {children}
    </section>
  );
}

export { styles as legalStyles };
