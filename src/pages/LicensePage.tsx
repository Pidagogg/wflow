import { Lock, LogOut } from "lucide-react";
import type { LicenseState } from "../types";
import { LicensePanel, MoveToCloud } from "../components/LicensePanel";

/**
 * The lock screen of a self-hosted copy whose licence is not active
 * (server/license.js): the Pro / Team subscription behind it ended, or the copy
 * could not confirm it for days. Nothing is deleted — the owner pastes a valid
 * key or renews, and anyone can move their account to the cloud from here.
 */
export default function LicensePage({
  license,
  onChange,
  onLogout,
}: {
  license: LicenseState;
  onChange: (l: LicenseState) => void;
  onLogout: () => void;
}) {
  return (
    <div className="license-lock">
      <div className="hub-top">
        <div className="hub-kicker">
          <Lock size={14} /> SELF-HOSTED
        </div>
        <h1>This copy is locked</h1>
        <p className="setup-note">
          Running W flow on your own machine or server needs an active Pro or Team plan. Your workflows, credentials and runs
          are all still here — renew the plan on w-flow.tech, or move your account to the cloud.
        </p>
      </div>
      <div className="setup-body">
        <LicensePanel license={license} onChange={onChange} />
        <MoveToCloud defaultCloud={license.server} />
      </div>
      <div className="setup-foot">
        <button className="btn btn-sm" onClick={onLogout}>
          <LogOut size={12} /> Log out
        </button>
      </div>
    </div>
  );
}
