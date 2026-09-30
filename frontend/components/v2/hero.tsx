"use client";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

// Empty state (Layout & shell §4). Greeting depends on the local clock, so it is
// only computed after mount to keep server and client markup identical.
export function greetingFor(hour: number) {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function Hero({
  agentHue = "#BCDEE8",
  name,
  children,
}: {
  /** Agent color for the greeting dot (spec default #BCDEE8). */
  agentHue?: string;
  /** Appended as ", {name}" when given. */
  name?: string | null;
  /** Composer, rendered inside .hero-composer. */
  children?: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const greeting = mounted
    ? greetingFor(new Date().getHours()) + (name ? `, ${name}` : "")
    : "";
  return (
    <div className="hero">
      <div className="hero-greet">
        <span
          className="agent-dot"
          style={{ background: agentHue } as CSSProperties}
          aria-hidden="true"
        />
        <span>{greeting || "\u00a0"}</span>
      </div>
      <h1>
        What should we <em>work on</em> today?
      </h1>
      {children && <div className="hero-composer">{children}</div>}
    </div>
  );
}
