"use client";
import { useId, useState, type ReactNode } from "react";
import { classes } from "./classes";

// .tx-tip (DESIGN-SPEC 9.14): a hint on hover and keyboard focus. Never essential
// content. Esc hides it while the trigger keeps focus.
export function Tooltip({
  text,
  up,
  children,
}: {
  text: string;
  up?: boolean;
  children: (props: { "aria-describedby": string }) => ReactNode;
}) {
  const id = useId();
  const [hidden, setHidden] = useState(false);
  return (
    <span
      className={classes("tx-tip", up && "tx-tip-up")}
      data-hidden={hidden ? "true" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") setHidden(true);
      }}
      onBlur={() => setHidden(false)}
      onMouseLeave={() => setHidden(false)}
    >
      {children({ "aria-describedby": id })}
      <span className="tx-tip-pop" role="tooltip" id={id}>
        {text}
      </span>
    </span>
  );
}
