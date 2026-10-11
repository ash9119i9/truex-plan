"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Banner } from "./login-card";
import { Icon } from "@/components/v2/icon";
import type { Role, WorkspaceRef } from "@/lib/session";
import {
  changeWorkspaceInvite,
  fetchWorkspaceInvites,
  sendWorkspaceInvite,
  type WorkspaceInvite,
  type WorkspaceResult,
} from "@/lib/workspaces";

export function WorkspaceInvitations({
  workspaces,
  currentId,
  onSignedOut,
}: {
  workspaces: WorkspaceRef[];
  currentId: string | null;
  onSignedOut: () => void;
}) {
  const [id, setId] = useState(
    workspaces.find((w) => w.id === currentId)?.id ?? workspaces[0].id,
  );
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "warn" | "info";
    lead: string;
  } | null>(null);
  const inFlight = useRef(false);
  function failure(result: Extract<WorkspaceResult<unknown>, { ok: false }>) {
    if (result.signedOut) onSignedOut();
    else setNotice({ tone: "warn", lead: result.message });
  }
  useEffect(() => {
    let live = true;
    setLoading(true);
    setInvites([]);
    setNotice(null);
    void fetchWorkspaceInvites(id).then((result) => {
      if (!live) return;
      setLoading(false);
      if (result.ok) setInvites(result.value);
      else failure(result);
    });
    return () => {
      live = false;
    };
  }, [id]);
  async function refresh() {
    const result = await fetchWorkspaceInvites(id);
    if (result.ok) setInvites(result.value);
    else failure(result);
  }
  async function mutate(
    invite?: WorkspaceInvite,
    action?: "resend" | "revoke",
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result =
        invite && action
          ? await changeWorkspaceInvite(id, invite.id, action)
          : await sendWorkspaceInvite(id, email, role);
      if (!result.ok) failure(result);
      else {
        if (!invite) setEmail("");
        setNotice({
          tone: result.value.sendError ? "warn" : "info",
          lead: result.value.sendError
            ? "Invitation saved, but email delivery failed. Resend it or contact your administrator."
            : action === "revoke"
              ? "Invitation revoked."
              : "Invitation sent. They can join with the Google account for that email.",
        });
      }
      await refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="au-card"
      aria-labelledby="invite-title"
      aria-busy={busy || loading}
    >
      <div className="au-panel-heading">
        <span className="au-panel-icon">
          <Icon name="at" size={20} />
        </span>
        <div>
          <h2 id="invite-title" className="au-section-title">
            Invite your team
          </h2>
          <p className="au-fine">Bring people into a team you manage.</p>
        </div>
      </div>
      <label className="au-field" htmlFor="invite-workspace">
        Workspace
        <select
          className="au-input"
          id="invite-workspace"
          value={id}
          disabled={busy}
          onChange={(e) => setId(e.target.value)}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      {notice && <Banner notice={notice} />}
      <form
        className="au-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void mutate();
        }}
      >
        <label className="au-field" htmlFor="invite-email">
          Google account email
          <input
            id="invite-email"
            className="au-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={254}
            disabled={busy || loading}
          />
        </label>
        <label className="au-field" htmlFor="invite-role">
          Role
          <select
            id="invite-role"
            className="au-input"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            disabled={busy || loading}
          >
            <option value="user">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <p className="au-fine">
          Admins can manage invitations and team connectors. Members see their
          own agents and conversations.
        </p>
        <button
          className="au-btn primary"
          disabled={busy || loading}
          type="submit"
        >
          {busy ? "Updating invitations…" : "Send invitation"}
        </button>
      </form>
      {loading ? (
        <div className="au-status" role="status">
          Loading invitations…
        </div>
      ) : (
        <>
          <div className="au-actions">
            <button
              className="au-btn"
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Refresh invitations
            </button>
          </div>
          <ul className="au-invites">
            {invites.map((i) => (
              <li key={i.id} className="au-invite">
                <strong className="au-invite-email">{i.email}</strong>
                <span className="au-fine">
                  {i.role === "admin" ? "Admin" : "Member"} ·{" "}
                  {i.status === "pending" &&
                  Date.parse(i.expiresAt) <= Date.now()
                    ? "Expired"
                    : i.status}{" "}
                  {i.sendError && i.status === "pending"
                    ? "· Email not sent"
                    : ""}
                </span>
                {(i.status === "pending" || i.status === "expired") && (
                  <div className="au-actions">
                    <button
                      className="au-btn"
                      type="button"
                      disabled={busy}
                      onClick={() => void mutate(i, "resend")}
                    >
                      Resend
                    </button>
                    <button
                      className="au-btn"
                      type="button"
                      disabled={busy}
                      onClick={() => void mutate(i, "revoke")}
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {!invites.length && <p className="au-fine">No invitations yet.</p>}
        </>
      )}
    </section>
  );
}
