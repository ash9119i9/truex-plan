"use client";
import { Icon } from "./icon";
import { useTheme } from "@/lib/use-theme";

// Account menu (Core components §5 "User menu anatomy"), without the Typeface section.
export type UserMenuProps = {
  name?: string;
  email?: string;
  /** Current workspace, shown under the account email. */
  workspace?: string;
  showWorkspaces?: boolean;
  role?: "user" | "admin";
  onSettings?: () => void;
  onWorkspaces?: () => void;
  onSignOut?: () => void;
};

export function UserMenu({
  name,
  email,
  workspace,
  showWorkspaces = true,
  role,
  onSettings,
  onWorkspaces,
  onSignOut,
}: UserMenuProps) {
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
            {email && <span className="muted sm block">{email}</span>}
            {((showWorkspaces && workspace) || role === "admin") && (
              <span className="muted sm block">
                {[
                  showWorkspaces ? workspace : "",
                  role === "admin" ? "Admin" : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
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
      {(onSettings || (showWorkspaces && onWorkspaces) || onSignOut) && (
        <div className="menu-sep" />
      )}
      {onSettings && (
        <button type="button" className="menu-item" onClick={onSettings}>
          <Icon name="gear" size={15} />
          Settings
        </button>
      )}
      {showWorkspaces && onWorkspaces && (
        <button type="button" className="menu-item" onClick={onWorkspaces}>
          <Icon name="grid" size={15} />
          Manage workspaces
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
