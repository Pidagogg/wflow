import { useEffect, useState } from "react";
import { Cookie } from "lucide-react";

/**
 * Cookie / local-storage consent banner.
 *
 * Shown on the first visit and remembered on this browser afterwards. W flow
 * only sets what it strictly needs to run — the login session cookie and a few
 * local-storage keys for editor preferences — so "necessary only" is a real
 * choice and never breaks the app; "accept all" additionally allows the
 * optional, anonymous usage preferences. The decision is stored both in
 * localStorage (so the banner stays gone) and in a small cookie (so the server
 * and the privacy policy can refer to it).
 */
export const COOKIE_CONSENT_KEY = "wflow.cookieConsent";
const COOKIE_NAME = "bf_cookie_consent";

export type CookieChoice = "all" | "necessary";

interface StoredConsent {
  choice: CookieChoice;
  at: string;
}

/** Read the saved decision (null when the visitor has not decided yet). */
export function getCookieConsent(): StoredConsent | null {
  try {
    const raw = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredConsent;
    if (parsed?.choice !== "all" && parsed?.choice !== "necessary") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the decision on this browser. */
export function saveCookieConsent(choice: CookieChoice) {
  const record: StoredConsent = { choice, at: new Date().toISOString() };
  try {
    localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify(record));
  } catch {
    /* private mode — the banner simply shows again next visit */
  }
  try {
    const maxAge = 60 * 60 * 24 * 180; // 180 days
    document.cookie = `${COOKIE_NAME}=${choice}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  } catch {
    /* ignore */
  }
}

/** Forget the decision, so the banner is shown again (Settings → Privacy). */
export function clearCookieConsent() {
  try {
    localStorage.removeItem(COOKIE_CONSENT_KEY);
  } catch {
    /* ignore */
  }
  try {
    document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    /* ignore */
  }
}

interface Props {
  /** the privacy policy lives at /datenschutz; hidden when the operator hid it */
  hideLegal?: boolean;
  /**
   * Bump this from outside to force the banner open again (used by the
   * Settings → Privacy "change your choice" button).
   */
  reopenToken?: number;
}

export default function CookieConsent({ hideLegal, reopenToken = 0 }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!getCookieConsent()) {
      // a short delay keeps the banner from covering the first paint
      const t = window.setTimeout(() => setOpen(true), 600);
      return () => window.clearTimeout(t);
    }
  }, []);

  useEffect(() => {
    if (reopenToken > 0) setOpen(true);
  }, [reopenToken]);

  const decide = (choice: CookieChoice) => {
    saveCookieConsent(choice);
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="cookie-banner" role="dialog" aria-live="polite" aria-label="Cookie notice">
      <div className="cookie-banner-text">
        <Cookie size={15} />
        <div>
          <strong>Cookies &amp; local storage</strong>
          <span>
            W flow uses a technically necessary session cookie to keep you logged in, plus local storage for
            editor preferences. Optional preferences help us keep the workspace tidy — you decide.{" "}
            {!hideLegal && (
              <a href="/datenschutz" target="_blank" rel="noopener">
                Privacy policy
              </a>
            )}
          </span>
        </div>
      </div>
      <div className="cookie-banner-actions">
        <button className="btn btn-sm" onClick={() => decide("necessary")}>
          Necessary only
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => decide("all")}>
          Accept all
        </button>
      </div>
    </div>
  );
}
