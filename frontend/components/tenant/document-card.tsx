"use client";
import { documentKind, type DocumentKind } from "@/lib/document-kind";
import { docSize, splitName } from "@/lib/tenant-files";
import { Button } from "@/components/tx/button";
import { Spin } from "@/components/tx/live";
import { Icon, type IconName } from "@/components/tx/icon";

// One file in a reply or on a sent message (DESIGN-SPEC 12.3): a quiet row
// with its kind, its name (the extension stays visible), type and size, and
// Download. The name opens the file viewer when the file can be opened.
const KIND_ICON: Record<DocumentKind, IconName> = {
  document: "file",
  sheet: "sheet",
  slides: "slides",
  code: "code",
  text: "text",
};

// "tooLarge": over the per-file limit, so it can never be saved: no Retry.
export type DocumentState =
  "ready" | "writing" | "unsaved" | "saving" | "tooLarge";

export function DocumentCard({
  name,
  size,
  state,
  version,
  active = false,
  onOpen,
  onDownload,
  onRetry,
}: {
  name: string;
  size: number;
  state: DocumentState;
  /** Shown as "v2" from the second version on. */
  version?: number;
  /** The viewer shows this file now. */
  active?: boolean;
  onOpen?: () => void;
  onDownload?: () => void;
  onRetry?: () => void;
}) {
  const { kind, label } = documentKind(name);
  const { base, ext } = splitName(name);
  const title = (
    <span className="dc-name">
      <span className="dc-base">{base}</span>
      {ext && <span className="dc-ext">{ext}</span>}
    </span>
  );
  const meta =
    state === "writing" ? (
      <span className="dc-meta is-live">
        <Spin />
        Writing…
      </span>
    ) : state === "saving" ? (
      <span className="dc-meta is-live">
        <Spin />
        Saving…
      </span>
    ) : state === "unsaved" ? (
      <span className="dc-meta is-bad">
        <Icon name="alert" size="sm" />
        Couldn’t save this file
      </span>
    ) : state === "tooLarge" ? (
      <span className="dc-meta is-bad">
        <Icon name="alert" size="sm" />
        Too large to save (over 20 MB)
      </span>
    ) : (
      <span className="dc-meta">
        {label} · {docSize(size)}
        {version && version > 1 ? ` · v${version}` : ""}
      </span>
    );
  return (
    <article
      className={
        state === "ready"
          ? active
            ? "dc is-active"
            : "dc"
          : state === "saving" || state === "tooLarge"
            ? "dc is-unsaved"
            : `dc is-${state}`
      }
      aria-label={name}
    >
      <span className="dc-tile" aria-hidden="true">
        <Icon name={KIND_ICON[kind]} />
      </span>
      {onOpen &&
      state !== "unsaved" &&
      state !== "saving" &&
      state !== "tooLarge" ? (
        <button
          type="button"
          className="dc-open"
          aria-label={`Open ${name}`}
          onClick={onOpen}
        >
          {title}
          {meta}
        </button>
      ) : (
        <span className="dc-open is-static">
          {title}
          {meta}
        </span>
      )}
      {state === "tooLarge" ? null : state === "unsaved" ||
        state === "saving" ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Retry saving ${name}`}
          disabled={state === "saving" || !onRetry}
          onClick={onRetry}
        >
          Retry
        </Button>
      ) : (
        <Button
          iconOnly
          icon="download"
          variant="ghost"
          size="sm"
          aria-label={`Download ${name}`}
          title={
            state === "ready" && onDownload
              ? "Download"
              : "Not available to download yet"
          }
          disabled={state !== "ready" || !onDownload}
          onClick={onDownload}
        />
      )}
    </article>
  );
}
