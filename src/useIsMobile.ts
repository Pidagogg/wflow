// ============================================================================
// useIsMobile — true on phones and touch-only tablets.
//
// The workspace (canvas, drag-and-drop, wide tables) is built for a mouse and a
// wide screen. On these devices the welcome pages shrink to what works there —
// signing in, the account and the subscription — and the workspace warns that
// it may misbehave. Tracks the media query live, so rotating a tablet or
// resizing a window switches views without a reload.
// ============================================================================
import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 760px), (hover: none) and (pointer: coarse) and (max-width: 1100px)";

function matches() {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile() {
  const [mobile, setMobile] = useState(matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}
