"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

const arrow = (
  <svg
    className="animated-link-arrow"
    fill="none"
    viewBox="0 0 10 10"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M1.004 9.166 9.337.833m0 0v8.333m0-8.333H1.004"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// A button that looks like an animated text link: the underline grows from
// the center on hover or keyboard focus, and an arrow slides in. The text is
// an inline span so the underline follows every line when it wraps, and the
// arrow stays with the last word instead of wrapping onto a line of its own.
export function AnimatedLink({
  children,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  const split =
    typeof children === "string" ? children.match(/^(.*?)(\S+)\s*$/s) : null;
  return (
    <button type={type} {...props} className={cn("animated-link", className)}>
      {split ? (
        <span className="animated-link-text">
          {split[1]}
          <span className="animated-link-tail">
            {split[2]}
            {arrow}
          </span>
        </span>
      ) : (
        <>
          <span className="animated-link-text">{children}</span>
          {arrow}
        </>
      )}
    </button>
  );
}

/**
 * Adapted from Skiper 40 Animated Link (Link003) by Skiper UI.
 * Author: @gurvinder-singh02 — https://gxuri.me
 * Free version; attribution to Skiper UI is required.
 */
