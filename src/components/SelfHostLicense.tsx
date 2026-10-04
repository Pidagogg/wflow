import { useEffect, useState } from "react";
import { CloudDownload, Copy, KeyRound, RefreshCw } from "lucide-react";
import { api } from "../api";

/**
 * The cloud half of self-hosting for a Pro account: its licence key (the
 * installer already puts it into the copy; paste it on a copy's lock screen
 * otherwise) and a one-time code to move a self-hosted copy's account here.
 */
export default function SelfHostLicense({ notify }: { notify: (text: string, kind?: "ok" | "err") => void }) {
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    api.license
      .myKey()
      .then((r) => setKey(r.key))
      .catch(() => setKey(""));
  }, []);

  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text).then(
      () => notify(`${what} copied.`),
      () => notify(`Could not copy — select the ${what.toLowerCase()} and copy it by hand.`, "err")
    );
  };

  const rotate = async () => {
    if (!window.confirm("Make a new licence key? Copies that use the old key lock at their next check until you paste the new one.")) return;
    try {
      setKey((await api.license.rotate()).key);
      notify("New licence key made — paste it into your copies.");
    } catch (err) {
      notify((err as Error).message, "err");
    }
  };

  const makeCode = async () => {
    try {
      setCode((await api.migrate.code()).code);
    } catch (err) {
      notify((err as Error).message, "err");
    }
  };

  if (!key) return null;
  return (
    <div className="selfhost-license">
      <div className="field-label">
        <KeyRound size={12} /> Licence key
      </div>
      <div className="setup-actions">
        <input readOnly value={key} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 200 }} />
        <button className="btn btn-sm" onClick={() => copy(key, "Licence key")} title="Copy the key">
          <Copy size={12} />
        </button>
        <button className="btn btn-sm" onClick={rotate} title="Make a new key (the old one stops working)">
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="field-help">
        Your copies check this key every few hours; nothing else is sent. When your plan ends, they lock until you renew.
      </div>
      <div className="field-label" style={{ marginTop: 10 }}>
        <CloudDownload size={12} /> Move a self-hosted copy here
      </div>
      {code ? (
        <>
          <div className="setup-actions">
            <input readOnly value={code} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 200 }} />
            <button className="btn btn-sm" onClick={() => copy(code, "Move code")} title="Copy the code">
              <Copy size={12} />
            </button>
          </div>
          <div className="field-help">Paste it into the copy (Setup → Move to the cloud) within an hour. It works once.</div>
        </>
      ) : (
        <button className="btn btn-sm" onClick={makeCode}>
          Create a move code
        </button>
      )}
    </div>
  );
}
