import { useEffect, useState } from "react";
import { Download, Lock, MonitorDown, Sparkles } from "lucide-react";
import { api, INSTALLER_OSES, detectOs } from "../api";
import type { SelfhostStatus } from "../types";
import { Toast, useToast } from "./Toast";
import SelfHostLicense from "./SelfHostLicense";
import { proCtaLabel, proSalesOpen } from "../proStatus";

interface Props {
  /** false while the visitor is not logged in — the card then offers login */
  authed: boolean;
  /** open the Pro page (upgrade prompt shown instead of the download) */
  onUpgrade: () => void;
  /** open the login card (guests) */
  onLogin: () => void;
}

/**
 * The "Self-hosted version" entry card. Used by the welcome page both before and
 * after login: a Pro account can download the installer for its own operating
 * system, and for the other two as well (install the builder here and a runner
 * on a VPS, for instance). The installer asks where the copy should live, which
 * port it uses, where workflows execute and where the data is stored.
 */
export default function SelfHostedCard({ authed, onUpgrade, onLogin }: Props) {
  const { toast, show } = useToast();
  const [status, setStatus] = useState<SelfhostStatus | null>(null);
  const own = detectOs();
  const ownLabel = INSTALLER_OSES.find((o) => o.key === own)?.label || "Linux";

  useEffect(() => {
    if (!authed) return;
    let live = true;
    api.selfhosted
      .info()
      .then((s) => live && setStatus(s))
      .catch(() =>
        live && setStatus({ pro: false, ready: false, reason: "Could not read the installer state.", port: 3001 })
      );
    return () => {
      live = false;
    };
  }, [authed]);

  // Start the download and open the address the local copy will serve. Both
  // happen in the click handler (no await in between) so the browser treats the
  // new tab as user-initiated and does not block it.
  const download = (os: "windows" | "mac" | "linux") => {
    if (!status?.ready) return;
    const label = INSTALLER_OSES.find((o) => o.key === os)?.label || os;
    const link = document.createElement("a");
    link.href = api.selfhosted.installerUrl(os);
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.open(`http://localhost:${status.port}`, "_blank");
    show(
      `Installer for ${label} downloading — run it on that machine and answer its setup questions; the tab that just opened shows your own copy.`
    );
  };

  const pro = !!status?.pro;

  return (
    <article className="entry-card">
      <div className="entry-card-icon">
        <MonitorDown size={18} />
      </div>
      <h3>Self-hosted version</h3>
      <p>
        Download a one-file installer and run the whole builder on your own machine. It asks where the copy should
        live, where its workflows execute (here or a runner on your own VPS) and where workflows and credentials are
        stored.
      </p>
      <div className="entry-card-meta">
        <span><Download size={12} /> Windows · macOS · Linux</span>
        <span>Own database, own encryption key</span>
      </div>

      {!authed ? (
        <button className="btn btn-primary entry-card-btn" onClick={onLogin}>
          <Lock size={13} /> Log in to check your plan
        </button>
      ) : status === null ? (
        <span className="entry-card-note">Checking your plan…</span>
      ) : pro ? (
        <>
          <button
            className="btn btn-primary entry-card-btn"
            onClick={() => download(own)}
            disabled={!status.ready}
            title={status.ready ? `Download the ${ownLabel} installer` : status.reason}
          >
            <Download size={13} /> Download for {ownLabel}
          </button>
          {/* The other two platforms: install a runner on the VPS, the builder here. */}
          <div className="entry-card-picks">
            {INSTALLER_OSES.filter((o) => o.key !== own).map((o) => (
              <button
                key={o.key}
                className="btn btn-sm"
                onClick={() => download(o.key)}
                disabled={!status.ready}
                title={`Download the ${o.label} installer (.${o.ext})`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <SelfHostLicense notify={(text, kind) => show(text, kind)} />
        </>
      ) : (
        <div className="entry-card-locked">
          <span className="entry-card-note">
            <Lock size={12} /> Included with Pro
          </span>
          <button className="btn btn-primary entry-card-btn" onClick={onUpgrade}>
            <Sparkles size={13} /> {proCtaLabel("Upgrade to unlock")}
          </button>
          <span className="entry-card-fine">
            {proSalesOpen() ? "Downloads are gated behind a paid subscription." : "Until then every account uses the free plan in the cloud workspace."}
          </span>
        </div>
      )}
      <Toast toast={toast} />
    </article>
  );
}
