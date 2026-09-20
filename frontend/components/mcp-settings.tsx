"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Profile = {
  id: string;
  name: string;
  enabled: boolean;
  transport: string;
};
export function McpSettings({ agentId }: { agentId: string }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const transport = "http";
  const [auth, setAuth] = useState("none");
  useEffect(() => {
    let active = true;
    api(`/api/agents/${encodeURIComponent(agentId)}/mcp`)
      .then((data) => {
        if (!active) return;
        setProfiles(data.profiles);
        setSelected(data.profileIds);
        setReady(true);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [agentId]);
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/mcp`, {
        profileIds: selected,
      });
      setNotice("Saved. Start a new chat to use these MCP servers.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = {
        name: String(data.get("name")).trim(),
        transport,
        url: String(data.get("url")).trim(),
        auth: {
          kind: auth,
          ...(auth === "header"
            ? { headerName: String(data.get("headerName")).trim() }
            : {}),
        },
        ...(auth !== "none" ? { apiKey: String(data.get("apiKey")) } : {}),
      };
      const profile = await api("/api/mcp", body);
      setProfiles((old) => [...old, { ...profile, enabled: true, transport }]);
      setSelected((old) => [...old, profile.id]);
      form.reset();
      setAuth("none");
      setNotice(
        "Server created and selected. Save attachments to enable it for this agent.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const missing = selected.filter((id) => !profiles.some((p) => p.id === id));
  return (
    <details className="mcp-settings">
      <summary>Connected tools (MCP)</summary>
      <p>
        Attach tools and data sources to this agent. Changes apply to new chats.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!ready ? (
        <p>Loading configuration…</p>
      ) : (
        <>
          <fieldset disabled={busy}>
            <legend>Available servers</legend>
            {profiles.length === 0 && <p>No MCP servers configured yet.</p>}
            {[
              ...profiles,
              ...missing.map((id) => ({
                id,
                name: `Missing profile: ${id}`,
                enabled: false,
                transport: "unknown",
              })),
            ].map((p) => (
              <label className="mcp-option" key={p.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  disabled={!p.enabled && !selected.includes(p.id)}
                  onChange={(e) =>
                    setSelected((old) =>
                      e.target.checked
                        ? [...old, p.id]
                        : old.filter((id) => id !== p.id),
                    )
                  }
                />
                {p.name} · {p.transport}
                {!p.enabled && " (unavailable — remove attachment)"}
              </label>
            ))}
            <button type="button" onClick={save}>
              Save attachments
            </button>
          </fieldset>
          <details>
            <summary>Add an MCP server</summary>
            <form onSubmit={create}>
              <fieldset disabled={busy}>
                <label>
                  Name
                  <input
                    name="name"
                    required
                    pattern="[A-Za-z0-9_-]{1,64}"
                    maxLength={64}
                    placeholder="sap-tools"
                  />
                </label>
                <label>
                  Endpoint URL
                  <input
                    name="url"
                    type="url"
                    required
                    placeholder="https://example.com/mcp"
                  />
                </label>
                <label>
                  Authentication
                  <select
                    value={auth}
                    onChange={(e) => setAuth(e.target.value)}
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer token</option>
                    <option value="header">API key header</option>
                  </select>
                </label>
                {auth === "header" && (
                  <label>
                    Header name
                    <input name="headerName" required placeholder="x-api-key" />
                  </label>
                )}
                {auth !== "none" && (
                  <label>
                    API key
                    <input
                      name="apiKey"
                      type="password"
                      autoComplete="new-password"
                      required
                    />
                  </label>
                )}
                <button type="submit">Create server</button>
              </fieldset>
            </form>
          </details>
        </>
      )}
    </details>
  );
}
