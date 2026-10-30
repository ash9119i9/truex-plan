import type { HTMLAttributes, ReactNode } from "react";
import { classes } from "./classes";
import { Icon, type IconName } from "./icon";
import { RefChip } from "./chip";
import { Tile } from "./tile";

// .tx-card (DESIGN-SPEC 9.18).
export function Card({
  pad,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { pad?: boolean; children: ReactNode }) {
  return (
    <div
      className={classes("tx-card", pad && "tx-card-pad", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

// The three non-happy states every list and panel needs. Each has its exit:
// empty invites one action, error names the smallest step forward, and loading
// has none because it already is one. A dead end is a design error.
export type StateCardProps =
  | {
      kind: "empty";
      icon: IconName;
      title: string;
      children: ReactNode;
      action: ReactNode;
    }
  | { kind: "loading"; title: `${string}…` }
  | {
      kind: "error";
      title: string;
      children: ReactNode;
      reference?: string;
      action: ReactNode;
    };

export function StateCard(props: StateCardProps) {
  if (props.kind === "loading") {
    return (
      <div className="tx-card tx-card-pad tx-state" aria-busy="true">
        <Tile tone="signal" size="lg">
          <span className="tx-spin" aria-hidden="true" />
        </Tile>
        <h4>
          <span className="tx-shimmer">{props.title}</span>
        </h4>
      </div>
    );
  }
  const error = props.kind === "error";
  return (
    <div
      className={classes(
        "tx-card tx-card-pad tx-state",
        error && "tx-state-error",
      )}
    >
      {error ? (
        <Tile tone="bad" size="lg">
          ×
        </Tile>
      ) : (
        <Tile size="lg">
          <Icon name={props.icon} size="lg" />
        </Tile>
      )}
      <h4>{props.title}</h4>
      <p>
        {props.children}
        {error && props.reference && (
          <>
            {" "}
            <RefChip value={props.reference} label="error reference" />
          </>
        )}
      </p>
      <span className="tx-row">{props.action}</span>
    </div>
  );
}
