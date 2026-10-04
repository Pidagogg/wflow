import { LockKeyhole } from "lucide-react";

interface Props {
  reason: string;
  onBack: () => void;
}

export default function DeactivatedPage({ reason, onBack }: Props) {
  return (
    <div className="deactivated-screen">
      <div className="deactivated-card" role="alert" aria-labelledby="deactivated-title">
        <div className="deactivated-icon"><LockKeyhole size={22} /></div>
        <div className="section-label">Account status</div>
        <h1 id="deactivated-title">Your account is deactivated</h1>
        <p>
          You cannot access W flow right now. If you believe this is a mistake, contact the
          administrator of this instance.
        </p>
        <div className="deactivated-reason">
          <strong>Reason</strong>
          <span>{reason || "The account is currently unavailable."}</span>
        </div>
        <button className="btn btn-primary" type="button" onClick={onBack}>Back to login</button>
      </div>
    </div>
  );
}
