"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, userMessage } from "@/lib/api";
import { useAppearance } from "@/lib/use-appearance";
import {
  createMcpAppHost,
  mcpAppHeight,
  MCP_APP_DEFAULT_HEIGHT,
  type McpAppHost,
  type McpAppHostContext,
} from "@/lib/mcp-app-host";
import { MCP_APP_CHANNEL, mcpAppDocument } from "@/lib/mcp-app-document";
import type { McpApp, McpAppRef } from "../../shared/mcp-apps";

// How long an app has to start before the reader is told it did not.
const START_TIMEOUT_MS = 12000;

// A connector's own page, shown in the conversation. It gets its tool call's
// input and result and nothing else: it runs in a frame with no origin, no
// network and no way to reach Truex except the bridge. See docs/MCP_APPS.md.
export function McpAppView({
  sessionId,
  app: ref,
}: {
  sessionId: string;
  app: McpAppRef;
}) {
  const [app, setApp] = useState<McpApp | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [height, setHeight] = useState(MCP_APP_DEFAULT_HEIGHT);
  const iframe = useRef<HTMLIFrameElement>(null);
  const host = useRef<McpAppHost | null>(null);
  const appearance = useAppearance();
  const isDark = appearance === "dark";
  const context = useRef<() => McpAppHostContext>(() => {
    throw new Error("not started");
  });
  context.current = () => ({
    theme: isDark ? "dark" : "light",
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions: {
      width: Math.round(iframe.current?.getBoundingClientRect().width || 728),
      maxHeight: 2000,
    },
    platform: "web",
    locale: typeof navigator === "undefined" ? undefined : navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    styles: { variables: {} },
  });

  useEffect(() => {
    let cancelled = false;
    setApp(null);
    setError("");
    setReady(false);
    setStalled(false);
    api(`/api/sessions/${sessionId}/mcp-apps/${encodeURIComponent(ref.id)}`)
      .then((value: McpApp) => {
        if (!cancelled) setApp(value);
      })
      .catch((e) => {
        if (!cancelled) setError(userMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, ref.id]);

  // The document is built once per app; the theme reaches it as host context.
  const source = useMemo(() => (app ? mcpAppDocument(app.html) : ""), [app]);

  useEffect(() => {
    if (!app) return;
    const current = createMcpAppHost({
      post: (message) =>
        iframe.current?.contentWindow?.postMessage(
          { channel: MCP_APP_CHANNEL, dir: "down", message },
          "*",
        ),
      hostContext: () => context.current(),
      onSizeChanged: ({ height: reported }) => {
        const next = mcpAppHeight(reported);
        if (next !== undefined) setHeight(next);
      },
      onReady: () => setReady(true),
    });
    current.setToolCall({ arguments: app.arguments, result: app.result });
    host.current = current;
    function receive(event: MessageEvent) {
      // Only the wrapper document's own window, with the opaque origin a
      // sandboxed frame has. The app itself cannot post here directly.
      if (
        !iframe.current ||
        event.source !== iframe.current.contentWindow ||
        event.origin !== "null"
      )
        return;
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        data.channel !== MCP_APP_CHANNEL ||
        data.dir !== "up"
      )
        return;
      current.receive(data.message);
    }
    addEventListener("message", receive);
    const timer = setTimeout(() => setStalled(true), START_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      removeEventListener("message", receive);
      current.dispose();
      if (host.current === current) host.current = null;
    };
  }, [app]);

  useEffect(() => {
    host.current?.updateHostContext();
  }, [isDark]);

  if (error)
    return (
      <div className="mcp-app-error" role="alert">
        This app could not be loaded. {error}
      </div>
    );
  if (!app) return <p role="status">Loading app…</p>;
  return (
    <figure className="mcp-app" aria-label={`${ref.tool} app`}>
      <figcaption>
        {ref.server} · {ref.tool}
      </figcaption>
      <iframe
        ref={iframe}
        title={`${ref.tool} app`}
        srcDoc={source}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        style={{ height }}
      />
      {!ready && !stalled && <p role="status">Starting app…</p>}
      {!ready && stalled && (
        <p role="alert" className="mcp-app-error">
          This app did not start. Its page may not support this version of
          Truex.
        </p>
      )}
    </figure>
  );
}
