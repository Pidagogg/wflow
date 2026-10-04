// ============================================================================
// Which connected-account services ("Connect Google / Slack / …") the operator
// has set up in the admin panel. A service without a client ID + secret can
// only fail at the provider's consent screen, so the editor hides its account
// picker instead of offering it. The last answer is kept for the page's
// lifetime so reopening a node does not flash the picker in and out; every
// mount still asks again, so a change in the admin panel shows up on reopen.
//
// Some nodes cannot connect an account on this instance even when their
// service is set up (the cloud only asks Google for its verified scopes —
// shared/oauth.js GOOGLE_VERIFIED_SCOPES). For those the service reads as not
// set up, so the node shows its pasted-token field instead of the picker.
// ============================================================================
import { useEffect, useState } from "react";
import { api } from "./api";

type State = { providers: Record<string, boolean>; unavailable: string[] };

let last: State | null = null;

export function useConnectionProviders(nodeType?: string): Record<string, boolean> | null {
  const [state, setState] = useState(last);
  useEffect(() => {
    let alive = true;
    api.connections
      .list()
      .then((res) => {
        last = { providers: res.providers || {}, unavailable: res.unavailable || [] };
        if (alive) setState(last);
      })
      .catch(() => {
        /* keep the last answer — the picker itself reports connection errors */
      });
    return () => {
      alive = false;
    };
  }, []);
  if (!state) return null;
  if (!nodeType || !state.unavailable.includes(nodeType)) return state.providers;
  return Object.fromEntries(Object.keys(state.providers).map((p) => [p, false]));
}
