import { Scale, ShieldCheck } from "lucide-react";

interface Props {
  /** "header" — compact links in the top bar; "footer" — the labelled strip at the bottom */
  variant: "header" | "footer";
}

// Legal pages (Impressum / Datenschutz) live on the main site at root paths and
// render [placeholder] marks until the operator fills in company details. They
// are linked from the welcome page (`/`) and the cookie banner only; callers
// skip this component when the admin switch hides legal pages.
const LINKS = [
  { href: "/impressum", label: "Impressum", sub: "Imprint", icon: Scale },
  { href: "/datenschutz", label: "Datenschutz", sub: "Privacy", icon: ShieldCheck },
];

export default function LegalLinks({ variant }: Props) {
  if (variant === "header") {
    return (
      <nav className="legal-links-header" aria-label="Legal">
        {LINKS.map(({ href, label, sub, icon: Icon }) => (
          <a key={href} href={href} target="_blank" rel="noopener" title={`${label} · ${sub}`}>
            <Icon size={12} /> {sub}
          </a>
        ))}
      </nav>
    );
  }
  return (
    <footer className="public-legal-foot">
      <span className="public-legal-label">Legal</span>
      {LINKS.map(({ href, label, sub, icon: Icon }) => (
        <a key={href} href={href} target="_blank" rel="noopener">
          <Icon size={13} /> {label} · {sub}
        </a>
      ))}
    </footer>
  );
}
