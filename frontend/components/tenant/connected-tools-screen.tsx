"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { userMessage } from "@/lib/api";
import {
  callbackErrorMessage,
  connectionDetail,
  connectorName,
  disconnect,
  fetchConnectors,
  readCallback,
  RETURN_KEY,
  safeReturnPath,
  startConnect,
  statusView,
  verifyConnection,
  type CallbackOutcome,
  type Connector,
  type ConnectorConnection,
  type ConnectorsResult,
  type StatusTone,
} from "@/lib/tenant-connectors";
import { Icon, type IconName } from "@/components/tx/icon";
import "@/styles/app/tools.css";

// Connected tools: the catalog merged with the member's own status. The
// member signs in to a connector (Connect), re-checks or removes it, and
// lands back here after the OAuth callback with a result banner. The design
// spec has no such screen; this is built from existing tokens (see
// connectors.css).

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; connectors: Connector[] }
  | { state: "not_configured" };

// Where the browser goes to start sign-in. Isolated so a test can drive the
// screen without a real navigation.
export interface ConnectedToolsDeps {
  navigate?: (url: string) => void;
  storage?: Pick<Storage, "getItem" | "removeItem">;
}

function toLoad(result: ConnectorsResult): Load {
  return result.kind === "not_configured"
    ? { state: "not_configured" }
    : { state: "ready", connectors: result.connectors };
}

export function ConnectedTools({
  tenantId,
  deps = {},
}: {
  tenantId: string;
  deps?: ConnectedToolsDeps;
}) {
  const navigate =
    deps.navigate ?? ((url: string) => window.location.assign(url));
  const storage =
    deps.storage ??
    (typeof window === "undefined" ? undefined : window.sessionStorage);

  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The callback result, read once from the URL on mount.
  const [callback, setCallback] = useState<CallbackOutcome>({ kind: "none" });
  const [returnPath, setReturnPath] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const outcome = readCallback(window.location.search);
    setCallback(outcome);
    if (outcome.kind === "connected") {
      // A chat that started the connect stored where to go back to.
      try {
        const stored = safeReturnPath(storage?.getItem(RETURN_KEY) ?? null);
        if (stored) setReturnPath(stored);
        storage?.removeItem(RETURN_KEY);
      } catch {
        /* Storage can be unavailable; the back link is simply not shown. */
      }
      // Clear the query so a refresh doesn't re-announce the result.
      window.history.replaceState(null, "", window.location.pathname);
    }
    // Only on mount: the callback is a one-time arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    fetchConnectors().then(
      (result) => {
        if (live) setLoad(toLoad(result));
      },
      (error) => {
        if (live)
          setLoad({
            state: "error",
            message: userMessage(
              error,
              "Connected tools couldn't be loaded. Try again.",
            ),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const known =
    load.state === "ready"
      ? load.connectors.map((c) => ({
          slug: c.slug,
          displayName: c.displayName,
        }))
      : [];

  const updateConnection = useCallback(
    (slug: string, connection: ConnectorConnection) => {
      setLoad((current) =>
        current.state === "ready"
          ? {
              state: "ready",
              connectors: current.connectors.map((c) =>
                c.slug === slug ? { ...c, connection } : c,
              ),
            }
          : current,
      );
    },
    [],
  );

  const resultBanner =
    callback.kind === "connected" ? (
      <div
        className="connector-result is-good"
        role="status"
        aria-live="polite"
      >
        <Icon name="check" />
        <span className="grow">
          {connectorName(callback.slug, known)} is connected.
        </span>
        {returnPath && (
          <Link className="tx-btn" href={returnPath}>
            Back to chat
          </Link>
        )}
      </div>
    ) : callback.kind === "error" ? (
      <div
        className="connector-result is-bad"
        role="alert"
        aria-live="assertive"
      >
        <Icon name="plug" />
        <span className="grow">
          {callbackErrorMessage(
            callback.code,
            callback.slug
              ? connectorName(callback.slug, known)
              : "the connector",
          )}
        </span>
      </div>
    ) : null;

  return (
    <div className="connectors">
      <header className="connectors-head">
        <h1>Connected tools</h1>
        <p className="muted">
          Connect a tool to let agents that use it work with your data.
          Everything stays read-only, and you can disconnect at any time.
        </p>
      </header>

      {resultBanner}

      {load.state === "loading" && (
        <p className="connectors-state" aria-busy="true">
          Loading connected tools…
        </p>
      )}

      {load.state === "not_configured" && (
        <div className="connectors-state">
          <h2>Connected tools aren&apos;t available</h2>
          <p>
            This workspace doesn&apos;t have any tools to connect yet. Check
            back later.
          </p>
        </div>
      )}

      {load.state === "error" && (
        <div className="connectors-state" role="alert">
          <h2>Couldn&apos;t load connected tools</h2>
          <p>{load.message}</p>
          <button
            type="button"
            className="tx-btn"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      )}

      {load.state === "ready" && load.connectors.length === 0 && (
        <div className="connectors-state">
          <h2>No tools to connect yet</h2>
          <p>
            When a tool becomes available in this workspace, it will appear
            here.
          </p>
        </div>
      )}

      {load.state === "ready" && load.connectors.length > 0 && (
        <ul className="connectors-list">
          {load.connectors.map((connector) => (
            <ConnectorRow
              key={connector.slug}
              connector={connector}
              tenantId={tenantId}
              navigate={navigate}
              onConnection={(connection) =>
                updateConnection(connector.slug, connection)
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "",
  good: "is-good",
  warn: "is-warn",
};

// One connector's card: its identity, status, and the actions for its state.
function ConnectorRow({
  connector,
  tenantId,
  navigate,
  onConnection,
}: {
  connector: Connector;
  tenantId: string;
  navigate: (url: string) => void;
  onConnection: (connection: ConnectorConnection) => void;
}) {
  const [busy, setBusy] = useState<"connect" | "verify" | "disconnect" | null>(
    null,
  );
  const [error, setError] = useState("");
  // After a disconnect whose provider revoke failed, the manual hint stays.
  const [removeHint, setRemoveHint] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const status = statusView(connector.connection);
  const detail = connectionDetail(connector.connection);
  const icon = (
    ["plug", "globe", "book", "folder"].includes(connector.icon)
      ? connector.icon
      : "plug"
  ) as IconName;

  const connect = async () => {
    if (busy) return;
    setBusy("connect");
    setError("");
    try {
      const url = await startConnect(connector.slug);
      navigate(url);
      // Navigation unmounts the page; nothing after this runs in practice.
    } catch (e) {
      if (!live.current) return;
      setBusy(null);
      setError(userMessage(e, "Sign-in couldn't be started. Try again."));
    }
  };

  const verify = async () => {
    if (busy) return;
    setBusy("verify");
    setError("");
    try {
      const connection = await verifyConnection(connector.slug);
      if (live.current) onConnection(connection);
    } catch (e) {
      if (live.current)
        setError(
          userMessage(e, "This connection couldn't be checked. Try again."),
        );
    } finally {
      if (live.current) setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy("disconnect");
    setError("");
    setRemoveHint(false);
    try {
      const { revoked } = await disconnect(connector.slug);
      if (!live.current) return;
      setRemoveHint(!revoked);
      onConnection({
        status: "not_connected",
        account: null,
        toolCount: null,
        lastVerifiedAt: null,
      });
    } catch (e) {
      if (live.current)
        setError(
          userMessage(e, "This tool couldn't be disconnected. Try again."),
        );
    } finally {
      if (live.current) setBusy(null);
    }
  };

  return (
    <li className="connector-card">
      <span className="connector-logo" aria-hidden="true">
        <Icon name={icon} size="lg" />
      </span>
      <div className="connector-text">
        <span className="connector-name block">{connector.displayName}</span>
      </div>
      <span className="connector-status">
        <span
          className={["connector-dot", TONE_CLASS[status.tone]]
            .filter(Boolean)
            .join(" ")}
          aria-hidden="true"
        />
        {status.label}
      </span>
      <p className="connector-desc muted sm">
        {detail || connector.description}
      </p>

      <div className="connector-actions">
        {status.action === "connect" && (
          <button
            type="button"
            className="tx-btn tx-primary"
            disabled={busy !== null}
            onClick={() => void connect()}
          >
            {busy === "connect"
              ? "Starting…"
              : `Connect ${connector.displayName}`}
          </button>
        )}
        {status.action === "reconnect" && (
          <button
            type="button"
            className="tx-btn tx-primary"
            disabled={busy !== null}
            onClick={() => void connect()}
          >
            {busy === "connect" ? "Starting…" : "Reconnect"}
          </button>
        )}
        {status.action === "admin" && (
          <button
            type="button"
            className="tx-btn"
            disabled={busy !== null}
            onClick={() => void connect()}
          >
            {busy === "connect" ? "Starting…" : "Try again"}
          </button>
        )}
        {status.action === "manage" && (
          <>
            <button
              type="button"
              className="tx-btn"
              disabled={busy !== null}
              onClick={() => void verify()}
            >
              {busy === "verify" ? "Checking…" : "Check connection"}
            </button>
            <button
              type="button"
              className="tx-btn tx-danger"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        )}
      </div>

      {/* GitHub signs a member in even when their org has not installed the
          app (the org's repositories are simply missing), so the admin help
          is shown on a working connection too, not only on
          needs_admin_approval. */}
      {(status.action === "admin" || status.action === "manage") &&
        connector.adminHelp && (
          <p className="connector-help">
            {connector.adminHelp.text}{" "}
            <a
              className="link"
              href={connector.adminHelp.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              Learn more
            </a>
          </p>
        )}

      {removeHint && (
        <p className="connector-hint" role="status">
          Also remove Truex at {connector.displayName} to revoke access
          completely.
        </p>
      )}

      {error && (
        <p className="connector-error tx-hint tx-errmsg" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
