"use client";
import { Icon } from "./icon";
import { useTheme } from "@/lib/use-theme";

// Account menu (Core components §5 "User menu anatomy"), without the Typeface section.
export type UserMenuProps = {
  name?: string;
  email?: string;
  onSettings?: () => void;
  onSignOut?: () => void;
};

export function UserMenu({ name, email, onSettings, onSignOut }: UserMenuProps) {
  const { isDark, toggle } = useTheme();
  const initial = (name || email || "").trim().charAt(0).toUpperCase();
  const hasCard = !!(name || email);

  return (
    <div className="menu">
      <div className="user-card">
        <span className="avatar" aria-hidden="true">
          {initial || <Icon name="user" size={16} />}
        </span>
        {hasCard ? (
          <span className="grow">
            {name && <span className="strong block">{name}</span>}
            {email && <span className="muted sm">{email}</span>}
          </span>
        ) : (
          <span className="grow strong">Account</span>
        )}
      </div>
      <div className="menu-sep" />
      <button type="button" className="menu-item" onClick={toggle}>
        <Icon name={isDark ? "sun" : "moon"} size={15} />
        {isDark ? "Light mode" : "Dark mode"}
      </button>
      {(onSettings || onSignOut) && <div className="menu-sep" />}
      {onSettings && (
        <button type="button" className="menu-item" onClick={onSettings}>
          <Icon name="gear" size={15} />
          Settings
        </button>
      )}
      {onSignOut && (
        <button type="button" className="menu-item" onClick={onSignOut}>
          <Icon name="logout" size={15} />
          Sign out
        </button>
      )}
    </div>
  );
}
