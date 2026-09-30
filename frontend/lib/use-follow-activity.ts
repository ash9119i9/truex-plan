"use client";
import { useEffect, useRef, useState } from "react";
import type { DomainEvent } from "../../shared/contracts";
import {
  FOLLOW_BATCH_MS,
  emptySeen,
  followAction,
  followTab,
  noteSeen,
  pickTab,
  readFollow,
  writeFollow,
  type FollowTab,
} from "./auto-tab";

const LABEL: Record<FollowTab, string> = {
  goal: "Goal",
  plan: "Plan",
  agents: "Agents",
};

// "Follow activity" for the session panel: stream events that start a goal,
// a plan or a helper move the panel to that tab, unless the user is busy
// with the panel or has turned following off.
export function useFollowActivity(options: {
  panelOpen: boolean;
  vw: number;
  // Opening the panel would leave an open sidebar in place.
  fitsOpen: boolean;
  tab: string;
  showTab: (tab: FollowTab, open: boolean) => void;
}) {
  const [enabled, setEnabledState] = useState(true),
    [announce, setAnnounce] = useState("");
  const live = useRef(options);
  live.current = options;
  const on = useRef(enabled);
  on.current = enabled;
  const state = useRef({
    seen: emptySeen(),
    want: null as FollowTab | null,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    manualAt: 0,
    dismissed: false,
  });
  // Stored after mount so the server render and first paint agree.
  useEffect(() => setEnabledState(readFollow()), []);
  useEffect(() => () => clearTimeout(state.current.timer), []);

  // Stable across renders: the stream subscription keeps the first copy.
  const api = useRef({
    onEvent(event: DomainEvent) {
      const s = state.current;
      const tab = followTab(event, s.seen);
      s.seen = noteSeen(s.seen, event);
      if (event.type === "turn.started") s.dismissed = false;
      if (!tab) return;
      s.want = pickTab(s.want, tab);
      s.timer ??= setTimeout(flush, FOLLOW_BATCH_MS);
    },
    // A new conversation: forget what the last stream showed.
    reset() {
      const s = state.current;
      clearTimeout(s.timer);
      Object.assign(s, { seen: emptySeen(), want: null, timer: undefined, dismissed: false });
    },
    // The user picked a tab themselves.
    manual() {
      state.current.manualAt = Date.now();
    },
    // The user closed the panel; it stays closed until the next turn.
    dismiss() {
      state.current.dismissed = true;
    },
  }).current;

  function flush() {
    const s = state.current,
      o = live.current,
      tab = s.want;
    s.want = null;
    s.timer = undefined;
    if (!tab) return;
    const panel = document.querySelector(".panel.activity");
    const inPanel =
      !!panel &&
      (panel.matches(":hover") || panel.contains(document.activeElement));
    const action = followAction({
      enabled: on.current,
      vw: o.vw,
      now: Date.now(),
      manualAt: s.manualAt,
      dismissed: s.dismissed,
      panelOpen: o.panelOpen,
      inPanel,
      fitsOpen: o.fitsOpen,
    });
    if (!action || (action === "switch" && o.tab === tab)) return;
    o.showTab(tab, action === "open");
    setAnnounce(`Session activity is showing the ${LABEL[tab]} tab.`);
  }

  function setEnabled(next: boolean) {
    setEnabledState(next);
    writeFollow(next);
    if (!next) {
      clearTimeout(state.current.timer);
      state.current.timer = undefined;
      state.current.want = null;
    }
  }

  return { ...api, enabled, setEnabled, announce };
}
