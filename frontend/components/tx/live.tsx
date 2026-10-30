"use client";
import type { ReactNode } from "react";
import { useAnnouncements, type Announcement } from "@/lib/announce";

// Live cues (DESIGN-SPEC 9.17). Each is a decorative mark beside a word; the
// static twin under reduced motion lives in primitives.css.
export const Spin = () => <span className="tx-spin" aria-hidden="true" />;
export const Pulse = () => <span className="tx-pulse" aria-hidden="true" />;
export const Dot = ({
  tone,
}: {
  tone: "ok" | "warn" | "bad" | "live" | "off";
}) => <span className={`tx-dot tx-dot-${tone}`} aria-hidden="true" />;
export const Shimmer = ({ children }: { children: ReactNode }) => (
  <span className="tx-shimmer">{children}</span>
);

// The one polite live region (11.12); mounted once by SharedLiveRegion.
export function LiveRegion({ messages }: { messages: Announcement[] }) {
  return (
    <div className="tx-sr" role="status" aria-live="polite">
      {messages.map((message) => (
        <p key={message.id}>{message.text}</p>
      ))}
    </div>
  );
}

export function SharedLiveRegion() {
  return <LiveRegion messages={useAnnouncements()} />;
}
