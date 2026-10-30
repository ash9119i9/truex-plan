import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { classes } from "./classes";
import { Icon, type IconName } from "./icon";

// .tx-btn (DESIGN-SPEC 9.4). One primary per surface; labels are verb + object.
type Common = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: "primary" | "dark" | "ghost" | "danger";
  size?: "xs" | "sm" | "lg";
  /** Leading icon, decorative. */
  icon?: IconName;
  /** A shortcut shown as a trailing keycap. */
  kbd?: string;
  /** While set, the button is busy: it shows a spinner and this label ("Sending…"). */
  working?: string;
};

export type ButtonProps =
  | (Common & { iconOnly?: false; children: ReactNode })
  | (Common & {
      iconOnly: true;
      icon: IconName;
      "aria-label": string;
      children?: never;
    });

export function Button(props: ButtonProps) {
  const {
    variant,
    size,
    icon,
    kbd,
    working,
    iconOnly,
    className,
    children,
    disabled,
    type = "button",
    ...rest
  } = props;
  return (
    <button
      type={type}
      className={classes(
        "tx-btn",
        variant && `tx-${variant}`,
        size && `tx-${size}`,
        iconOnly && "tx-icon",
        className,
      )}
      disabled={disabled || Boolean(working)}
      aria-busy={working ? true : undefined}
      {...rest}
    >
      {working ? (
        <>
          <span className="tx-spin" aria-hidden="true" />
          {working}
        </>
      ) : (
        <>
          {icon && <Icon name={icon} size={iconOnly ? undefined : "sm"} />}
          {children}
          {kbd && <kbd className="tx-kbd">{kbd}</kbd>}
        </>
      )}
    </button>
  );
}
