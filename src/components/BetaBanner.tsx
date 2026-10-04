// ============================================================================
// BetaBanner — the "Beta test" notice. Big on the welcome page, a single line
// in the workspace. Both follow one admin switch (Page setup → Beta test
// banner), delivered as `betaBanner` in /api/auth/config. Both carry the
// bug-report reward: a helpful report earns a free month of Pro once Pro
// launches.
// ============================================================================
import { FlaskConical } from "lucide-react";

export default function BetaBanner({ compact = false, onContact }: { compact?: boolean; onContact?: () => void }) {
  // The text sits in ONE span: as loose children of the flex row, every text
  // piece became its own flex item and the line broke apart.
  const contact = onContact ? (
    <button type="button" className="beta-contact" onClick={onContact}>
      Contact us
    </button>
  ) : (
    "use the contact form"
  );
  if (compact) {
    return (
      <p className="beta-note" role="note">
        <FlaskConical size={13} className="beta-note-icon" />
        <span>
          W flow is in <b>beta test</b> — things may still change or break. Found a problem? {contact} — a helpful bug
          report earns you <b>a free month of Pro</b> once Pro launches.
        </span>
      </p>
    );
  }
  return (
    <section className="beta-banner" role="note" aria-label="Beta test">
      <div className="beta-banner-tag">
        <FlaskConical size={16} /> BETA TEST
      </div>
      <div className="beta-banner-text">
        <p>
          W flow is in <b>beta test</b>. Everything is usable, but features may still change and you may run into bugs —
          your feedback helps us finish it{onContact ? <> — {contact}.</> : "."}
        </p>
        <p className="beta-banner-reward">
          <b>Report a bug, get Pro free:</b> everyone whose bug report helps us fix something gets <b>one month of Pro for
          free</b> as soon as Pro launches. Tell us what you did, what you expected and what happened instead.
        </p>
      </div>
    </section>
  );
}
