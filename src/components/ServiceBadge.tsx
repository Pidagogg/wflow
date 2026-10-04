import type { ReactNode } from "react";

/**
 * Small brand marks for the external services the builder connects to.
 *
 * Shown next to a service's name wherever it appears — the login card's
 * Google / GitHub buttons and the workflow nodes that talk to a service (the
 * node picker, the canvas and the node config modal). Google and GitHub get
 * their real marks; every other service gets a coloured monogram, which reads
 * the same at a glance without shipping dozens of licensed logos.
 */

interface ServiceDef {
  label: string;
  color: string;
  mono: string;
  /** matches anywhere in "...type name description..." (lowercased) */
  match: RegExp;
  svg?: ReactNode;
}

const GoogleMark = (
  <svg viewBox="0 0 48 48" width="100%" height="100%" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

const GithubMark = (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
    <path
      fill="#ffffff"
      d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.25-.02-2.27-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.39 1.24-3.23-.12-.31-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.18.77.84 1.24 1.91 1.24 3.23 0 4.63-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z"
    />
  </svg>
);

// Order matters: more specific services are listed before the generic ones.
export const SERVICES: Record<string, ServiceDef> = {
  googlesheets: { label: "Google Sheets", color: "#0f9d58", mono: "Sh", match: /google ?sheets|\bsheets\b|spreadsheet/i },
  googledrive: { label: "Google Drive", color: "#1a73e8", mono: "Dr", match: /google ?drive|googledrive/i },
  googlecalendar: { label: "Google Calendar", color: "#1a73e8", mono: "Cal", match: /google ?calendar/i },
  gmail: { label: "Gmail", color: "#ea4335", mono: "M", match: /\bgmail\b|inbound email|imap/i },
  googlesearch: { label: "Google Search", color: "#4285f4", mono: "G", match: /google (custom )?search/i },
  google: { label: "Google", color: "#4285f4", mono: "G", match: /\bgoogle\b/i, svg: GoogleMark },
  github: { label: "GitHub", color: "#24292e", mono: "GH", match: /github/i, svg: GithubMark },
  gitlab: { label: "GitLab", color: "#fc6d26", mono: "GL", match: /gitlab/i },
  slack: { label: "Slack", color: "#611f69", mono: "S", match: /\bslack\b/i },
  discord: { label: "Discord", color: "#5865f2", mono: "D", match: /\bdiscord\b/i },
  telegram: { label: "Telegram", color: "#229ed9", mono: "T", match: /\btelegram\b/i },
  whatsapp: { label: "WhatsApp", color: "#25d366", mono: "W", match: /whatsapp/i },
  notion: { label: "Notion", color: "#e8e8e8", mono: "N", match: /\bnotion\b/i },
  stripe: { label: "Stripe", color: "#635bff", mono: "St", match: /\bstripe\b/i },
  teams: { label: "Microsoft Teams", color: "#6264a7", mono: "T", match: /\bteams\b/i },
  outlook: { label: "Outlook 365", color: "#0f6cbd", mono: "O", match: /outlook/i },
  microsoft: { label: "Microsoft", color: "#0f6cbd", mono: "MS", match: /microsoft|onedrive|sharepoint|excel online|planner/i },
  jira: { label: "Jira", color: "#0052cc", mono: "J", match: /\bjira\b/i },
  airtable: { label: "Airtable", color: "#f82b60", mono: "A", match: /airtable/i },
  supabase: { label: "Supabase", color: "#3ecf8e", mono: "Sb", match: /supabase/i },
  hubspot: { label: "HubSpot", color: "#ff7a59", mono: "H", match: /hubspot/i },
  salesforce: { label: "Salesforce", color: "#00a1e0", mono: "SF", match: /salesforce/i },
  pipedrive: { label: "Pipedrive", color: "#017737", mono: "P", match: /pipedrive/i },
  trello: { label: "Trello", color: "#0079bf", mono: "Tr", match: /trello/i },
  asana: { label: "Asana", color: "#f06a6a", mono: "As", match: /\basana\b/i },
  clickup: { label: "ClickUp", color: "#7b68ee", mono: "CU", match: /clickup/i },
  todoist: { label: "Todoist", color: "#e44332", mono: "Td", match: /todoist/i },
  linear: { label: "Linear", color: "#5e6ad2", mono: "L", match: /\blinear\b/i },
  dropbox: { label: "Dropbox", color: "#0061ff", mono: "D", match: /dropbox/i },
  x: { label: "X (Twitter)", color: "#d9d9d9", mono: "X", match: /\bx \(twitter\)|twitter|\bx post\b/i },
  youtube: { label: "YouTube", color: "#ff0000", mono: "YT", match: /youtube/i },
  wordpress: { label: "WordPress", color: "#21759b", mono: "WP", match: /wordpress/i },
  mailchimp: { label: "Mailchimp", color: "#ffe01b", mono: "MC", match: /mailchimp/i },
  zendesk: { label: "Zendesk", color: "#03363d", mono: "Z", match: /zendesk/i },
  shopify: { label: "Shopify", color: "#96bf48", mono: "Sh", match: /shopify/i },
  twilio: { label: "Twilio", color: "#f22f46", mono: "Tw", match: /twilio/i },
  sendgrid: { label: "SendGrid", color: "#1a82e2", mono: "SG", match: /sendgrid/i },
  mailgun: { label: "Mailgun", color: "#d33a3a", mono: "MG", match: /mailgun/i },
  resend: { label: "Resend", color: "#e8e8e8", mono: "R", match: /\bresend\b/i },
  pagerduty: { label: "PagerDuty", color: "#06ac38", mono: "PD", match: /pagerduty/i },
  opsgenie: { label: "Opsgenie", color: "#2684ff", mono: "OG", match: /opsgenie/i },
  pushover: { label: "Pushover", color: "#249df1", mono: "PO", match: /pushover/i },
  ntfy: { label: "ntfy", color: "#3f8f29", mono: "nt", match: /\bntfy\b/i },
  deepl: { label: "DeepL", color: "#0f2b46", mono: "DL", match: /deepl/i },
  wikipedia: { label: "Wikipedia", color: "#e8e8e8", mono: "W", match: /wikipedia/i },
  reddit: { label: "Reddit", color: "#ff4500", mono: "R", match: /reddit/i },
  hackernews: { label: "Hacker News", color: "#ff6600", mono: "HN", match: /hacker ?news/i },
  tinyurl: { label: "TinyURL", color: "#1a73e8", mono: "TU", match: /tinyurl/i },
  aws: { label: "AWS", color: "#ff9900", mono: "AWS", match: /\baws\b|\bs3\b|amazon/i },
  mongodb: { label: "MongoDB", color: "#13aa52", mono: "M", match: /mongo/i },
  mysql: { label: "MySQL", color: "#00758f", mono: "My", match: /mysql/i },
  postgres: { label: "PostgreSQL", color: "#336791", mono: "Pg", match: /postgres/i },
  vonage: { label: "Vonage", color: "#871fff", mono: "V", match: /vonage/i },
  openai: { label: "OpenAI", color: "#10a37f", mono: "AI", match: /openai|\bgpt\b/i },
  anthropic: { label: "Anthropic", color: "#d4a27f", mono: "Cl", match: /anthropic|claude/i },
  gemini: { label: "Google Gemini", color: "#4285f4", mono: "Ge", match: /gemini/i },
  ollama: { label: "Ollama", color: "#e8e8e8", mono: "Ol", match: /ollama/i },
  mastodon: { label: "Mastodon", color: "#6364ff", mono: "Ma", match: /mastodon/i },
  bluesky: { label: "Bluesky", color: "#1185fe", mono: "Bs", match: /bluesky/i },
  gitea: { label: "Gitea", color: "#609926", mono: "Gt", match: /gitea|forgejo|codeberg/i },
  groq: { label: "Groq", color: "#f55036", mono: "Gq", match: /\bgroq\b/i },
  mistral: { label: "Mistral AI", color: "#fa520f", mono: "Mi", match: /mistral/i },
  deepseek: { label: "DeepSeek", color: "#4d6bfe", mono: "DS", match: /deepseek/i },
  openrouter: { label: "OpenRouter", color: "#6467f2", mono: "OR", match: /openrouter/i },
  brave: { label: "Brave Search", color: "#fb542b", mono: "Br", match: /brave search/i },
  arxiv: { label: "arXiv", color: "#b31b1b", mono: "aX", match: /arxiv/i },
  podcast: { label: "Podcast", color: "#8940fa", mono: "Pod", match: /podcast/i },
  rss: { label: "RSS", color: "#f26522", mono: "RSS", match: /\brss\b|atom feed/i },
};

/** Find the service a node (or any free text) refers to. */
export function detectService(...texts: Array<string | undefined | null>): string | null {
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  if (!hay.trim()) return null;
  for (const [key, def] of Object.entries(SERVICES)) {
    if (def.match.test(hay)) return key;
  }
  return null;
}

export function serviceForNode(type?: string, name?: string, description?: string): string | null {
  return detectService(type?.replace(/([a-z])([A-Z])/g, "$1 $2"), name, description);
}

interface BadgeProps {
  service?: string | null;
  size?: number;
  /** show the service name next to the mark */
  withLabel?: boolean;
}

export function ServiceBadge({ service, size = 16, withLabel = false }: BadgeProps) {
  const def = service ? SERVICES[service] : undefined;
  if (!def) return null;
  const common = {
    title: def.label,
    "aria-label": def.label,
    style: { width: size, height: size } as const,
  };
  return (
    <span className="service-badge" data-service={service} {...common}>
      {def.svg ? (
        <span className="service-badge-svg">{def.svg}</span>
      ) : (
        <span
          className="service-badge-mono"
          style={{
            background: def.color,
            width: size,
            height: size,
            fontSize: Math.max(7, Math.round(size * 0.52)),
          }}
        >
          {def.mono}
        </span>
      )}
      {withLabel && <span className="service-badge-label">{def.label}</span>}
    </span>
  );
}

/** Convenience: a badge derived from a node definition. */
export function NodeServiceBadge({ type, name, description, size = 14 }: { type?: string; name?: string; description?: string; size?: number }) {
  return <ServiceBadge service={serviceForNode(type, name, description)} size={size} />;
}
