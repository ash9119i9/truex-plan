"use client";
import { useEffect, useState, type ReactNode } from "react";
import { titleProblem, type ChatSummary } from "@/lib/tenant-chat";
import { Button } from "@/components/tx/button";
import { Menu } from "@/components/tx/menu";
import { Topbar, type AgentState } from "@/components/auth/workspace-frame";

// The open conversation's topbar (DESIGN-SPEC 11.3): agent tag, title, and the
// conversation's own actions (rename, archive) in one menu.
export function ChatTopbar({
  chat,
  busy,
  waiting,
  creating = false,
  start,
  onRename,
  onArchive,
}: {
  chat: ChatSummary;
  /** A reply is running: archiving waits for it. */
  busy: boolean;
  /** The reply is paused on a request. */
  waiting: boolean;
  /** The chat is being created by its first message: nothing to act on. */
  creating?: boolean;
  start?: ReactNode;
  onRename: (title: string) => Promise<string | null>;
  onArchive: () => Promise<string | null>;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "archive">("view");
  const [title, setTitle] = useState(chat.title);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  // Another chat, or a rename from elsewhere, resets the form.
  useEffect(() => {
    setMode("view");
    setError("");
  }, [chat.id]);
  const problem = mode === "rename" ? titleProblem(title) : null;

  const run = async (action: () => Promise<string | null>) => {
    if (working) return;
    setWorking(true);
    setError("");
    const failed = await action();
    setWorking(false);
    if (failed) setError(failed);
    else setMode("view");
  };

  const state: AgentState = waiting ? "waiting" : busy ? "working" : "ready";
  const hint = problem || error;

  const titleSlot =
    mode === "rename" ? (
      <form
        className="cs-rename"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) void run(() => onRename(title.trim()));
        }}
      >
        <label className="tx-sr" htmlFor="cs-rename-title">
          Conversation title
        </label>
        <input
          id="cs-rename-title"
          className="tx-input"
          value={title}
          autoFocus
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMode("view");
          }}
          aria-invalid={problem ? true : undefined}
          aria-describedby={hint ? "cs-rename-hint" : undefined}
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!!problem}
          working={working ? "Saving…" : undefined}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={working}
          onClick={() => setMode("view")}
        >
          Cancel
        </Button>
      </form>
    ) : undefined;

  const options = creating ? null : (
    <Menu
      label="Conversation options"
      className="cs-menu-wrap"
      panelClassName="cs-top-menu"
      items={[
        { id: "rename", label: "Rename" },
        ...(chat.status === "active"
          ? [
              {
                id: "archive",
                label: "Archive",
                detail: busy
                  ? "Wait for the reply, or stop it, first."
                  : undefined,
                disabled: busy,
                danger: true,
              },
            ]
          : []),
      ]}
      onSelect={(id) => {
        setError("");
        if (id === "rename") {
          setTitle(chat.title);
          setMode("rename");
        } else if (id === "archive") setMode("archive");
      }}
      trigger={(props) => (
        <Button
          {...props}
          iconOnly
          variant="ghost"
          size="sm"
          icon="list"
          aria-label="Conversation options"
        />
      )}
    />
  );

  const note =
    mode === "archive" ? (
      <div role="group" aria-labelledby="cs-archive-q" className="cs-confirm">
        <span id="cs-archive-q">
          Archive this conversation? It leaves your list and can&apos;t be
          continued.
        </span>
        <Button
          variant="danger"
          size="sm"
          autoFocus
          working={working ? "Archiving…" : undefined}
          onClick={() => void run(onArchive)}
        >
          Archive
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={working}
          onClick={() => setMode("view")}
        >
          Cancel
        </Button>
        {error && (
          <span className="cs-confirm-error" role="alert">
            {error}
          </span>
        )}
      </div>
    ) : hint ? (
      <p id="cs-rename-hint" className="cs-confirm-error" role="alert">
        {hint}
      </p>
    ) : undefined;

  return (
    <Topbar
      slim
      start={start}
      title={chat.title || "New conversation"}
      titleSlot={titleSlot}
      agent={chat.agent?.name ? { name: chat.agent.name, state } : undefined}
      actions={options}
      note={note}
    />
  );
}
