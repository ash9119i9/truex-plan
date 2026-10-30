"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/tx/icon";

// New-conversation hero (DESIGN-SPEC 11.4). The greeting depends on the local
// clock, so it is only computed after mount to keep server and client markup
// identical.
export function greetingFor(hour: number): { text: string; icon: IconName } {
  if (hour < 5) return { text: "Working late", icon: "moon" };
  if (hour < 12) return { text: "Good morning", icon: "sunrise" };
  if (hour < 18) return { text: "Good afternoon", icon: "sun" };
  if (hour < 22) return { text: "Good evening", icon: "sunset" };
  return { text: "Working late", icon: "moon" };
}

export function Hero({
  name,
  children,
}: {
  /** Appended as ", {name}" when given. */
  name?: string | null;
  /** The hero composer and anything under it. */
  children?: ReactNode;
}) {
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => setHour(new Date().getHours()), []);
  const greeting = hour === null ? null : greetingFor(hour);
  return (
    <div className="cs-hero">
      <div className="cs-hero-in">
        <div className="cs-greet">
          {greeting && <Icon name={greeting.icon} className="cs-greet-ic" />}
          <span>
            {greeting ? greeting.text + (name ? `, ${name}` : "") : "\u00a0"}
          </span>
        </div>
        <h1 className="cs-hero-h t-h2">
          What should we <em>work on</em> today?
        </h1>
        {children && <div className="cs-hero-composer">{children}</div>}
      </div>
    </div>
  );
}
