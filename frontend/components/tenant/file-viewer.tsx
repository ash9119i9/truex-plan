"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CopyTextButton,
  StreamingMarkdown,
} from "@/components/streaming-markdown";
import { Icon } from "@/components/v2/icon";
import { userMessage } from "@/lib/api";
import type { LiveReply } from "@/lib/tenant-chat";
import type { RetryState } from "./file-card";
import {
  cachedFileContent,
  fileTag,
  filesOfRun,
  formatBytes,
  hasSource,
  lineCount,
  MAX_PREVIEW_BYTES,
  parseCsv,
  previewKind,
  resolveSubject,
  sandboxedHtml,
  typeName,
  type ChatFile,
  type ViewerSubject,
  type ViewerTarget,
} from "@/lib/tenant-files";

type Loaded =
  | { state: "loading" }
  | { state: "text"; text: string }
  | { state: "image"; url: string }
  | { state: "large" }
  | { state: "none" }
  | { state: "error"; message: string };

function useFileContent(
  chatId: string,
  file: ChatFile | null,
  attempt: number,
): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    if (!file) return;
    const kind = previewKind(file.name);
    if (kind === "none") return setLoaded({ state: "none" });
    if (kind !== "image" && file.size > MAX_PREVIEW_BYTES)
      return setLoaded({ state: "large" });
    let cancelled = false;
    let url: string | null = null;
    setLoaded({ state: "loading" });
    cachedFileContent(chatId, file.id)
      .then(async (blob) => {
        if (cancelled) return;
        if (kind === "image") {
          url = URL.createObjectURL(blob);
          setLoaded({ state: "image", url });
          return;
        }
        const text = await blob.text();
        if (!cancelled) setLoaded({ state: "text", text });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoaded({
            state: "error",
            message: userMessage(error, "The file couldn't be loaded."),
          });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [chatId, file, attempt]);
  return file ? loaded : { state: "loading" };
}

// The file panel: one file at a time, with Preview and Source. Opened from a
// file card, or by itself when a reply starts writing a new file, so the
// text can be watched as it is written.
export function FileViewer({
  chatId,
  target,
  files,
  live,
  onSelect,
  onClose,
  onDownload,
  unsaved,
  saving,
  onSave,
}: {
  chatId: string;
  target: ViewerTarget;
  files: readonly ChatFile[];
  live: LiveReply | null;
  onSelect: (target: ViewerTarget) => void;
  onClose: () => void;
  onDownload: (file: ChatFile) => void;
  // The target reply's files that couldn't be saved, its retry (if any),
  // and how to retry them.
  unsaved: readonly string[];
  saving: RetryState | undefined;
  onSave: () => void;
}) {
  const subject = resolveSubject(target, files, live);
  const path = subject.state === "ready" ? subject.file.path : subject.path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const file = subject.state === "ready" ? subject.file : null;
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [attempt, setAttempt] = useState(0);
  const loaded = useFileContent(chatId, file, attempt);
  const heading = useRef<HTMLHeadingElement>(null);
  const kind = previewKind(name);
  const source = hasSource(name);
  // Written but not stored, and won't be without a retry.
  const notSaved =
    (subject.state === "missing" || subject.state === "saving") &&
    unsaved.includes(subject.path);

  // A new file starts on Preview, with focus on its name.
  useEffect(() => {
    setTab("preview");
    heading.current?.focus({ preventScroll: true });
  }, [target.runId, target.path, target.fileId]);

  // The reply's files, for "1 of N".
  const siblings = useMemo(() => {
    const paths = filesOfRun(files, target.runId).map((f) => f.path);
    if (!paths.includes(target.path)) paths.push(target.path);
    return paths;
  }, [files, target.runId, target.path]);
  const index = siblings.indexOf(target.path);

  const text =
    subject.state === "writing"
      ? subject.text
      : loaded.state === "text"
        ? loaded.text
        : null;
  const tag = fileTag(name);
  const stats = [
    typeName(name),
    file ? formatBytes(file.size) : null,
    text !== null && source
      ? `${lineCount(text).toLocaleString("en-US")} lines`
      : null,
  ].filter(Boolean);

  return (
    <div
      className="file-viewer"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="fv-head">
        <span className={`file-tile lg ft-${tag.tone}`} aria-hidden="true">
          {tag.label}
        </span>
        <div className="fv-title">
          <h2 ref={heading} tabIndex={-1}>
            {name}
            {file && file.version > 1 && (
              <span className="file-version">v{file.version}</span>
            )}
          </h2>
          <p className="fv-stats">
            {stats.join(" · ")}
            {subject.state === "writing" && (
              <span className="file-writing">
                <span className="spinner" aria-hidden="true" />
                Writing…
              </span>
            )}
            {subject.state === "saving" && (
              <span className="file-writing">
                <span className="spinner" aria-hidden="true" />
                Saving…
              </span>
            )}
          </p>
        </div>
        {siblings.length > 1 && (
          <div className="fv-nav" aria-label="Files from this reply">
            <button
              type="button"
              className="icon-btn ghost"
              aria-label="Previous file"
              disabled={index <= 0}
              onClick={() =>
                onSelect({ runId: target.runId, path: siblings[index - 1] })
              }
            >
              <Icon name="chevronL" size={15} />
            </button>
            <span className="fv-count">
              {index + 1} of {siblings.length}
            </span>
            <button
              type="button"
              className="icon-btn ghost"
              aria-label="Next file"
              disabled={index >= siblings.length - 1}
              onClick={() =>
                onSelect({ runId: target.runId, path: siblings[index + 1] })
              }
            >
              <Icon name="chevronR" size={15} />
            </button>
          </div>
        )}
        <button
          type="button"
          className="icon-btn ghost"
          aria-label="Close file"
          onClick={onClose}
        >
          <Icon name="x" size={16} />
        </button>
      </header>
      <div className="fv-bar">
        {source && kind !== "text" ? (
          <div className="fv-tabs" role="tablist" aria-label="View">
            {(["preview", "source"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? "is-active" : undefined}
                onClick={() => setTab(t)}
              >
                {t === "preview" ? "Preview" : "Source"}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <div className="fv-actions">
          {text !== null && source && (
            <CopyTextButton text={text} label="Copy" />
          )}
          <button
            type="button"
            className="btn-soft"
            disabled={!file}
            onClick={() => file && onDownload(file)}
          >
            Download
          </button>
        </div>
      </div>
      <div
        className="fv-body"
        role={source && kind !== "text" ? "tabpanel" : undefined}
        aria-busy={
          !notSaved && (subject.state !== "ready" || loaded.state === "loading")
        }
      >
        <ViewerBody
          subject={subject}
          loaded={loaded}
          name={name}
          tab={tab}
          onRetry={() => setAttempt((n) => n + 1)}
          onDownload={file ? () => onDownload(file) : null}
          unsaved={notSaved ? { saving, onSave } : null}
        />
      </div>
    </div>
  );
}

function ViewerBody({
  subject,
  loaded,
  name,
  tab,
  onRetry,
  onDownload,
  unsaved,
}: {
  subject: ViewerSubject;
  loaded: Loaded;
  name: string;
  tab: "preview" | "source";
  onRetry: () => void;
  onDownload: (() => void) | null;
  // Set when the file couldn't be saved and can be retried.
  unsaved: { saving: RetryState | undefined; onSave: () => void } | null;
}) {
  const kind = previewKind(name);
  if (unsaved)
    return (
      <div className="fv-error" role="alert">
        <p>
          {unsaved.saving && !unsaved.saving.busy
            ? unsaved.saving.message
            : "This file couldn't be saved."}
        </p>
        <button
          type="button"
          className="btn-soft"
          onClick={unsaved.onSave}
          disabled={unsaved.saving?.busy === true}
        >
          {unsaved.saving?.busy ? "Saving…" : "Retry"}
        </button>
      </div>
    );
  if (subject.state === "missing")
    return (
      <p className="fv-note" role="status">
        This file wasn&apos;t saved with the reply.
      </p>
    );
  if (subject.state === "writing") {
    if (!subject.text) return <Skeleton />;
    return (
      <>
        <TextView text={subject.text} kind={kind} tab={tab} streaming />
        {subject.truncated && (
          <p className="fv-note">The rest appears when the file is finished.</p>
        )}
      </>
    );
  }
  if (subject.state === "saving" || loaded.state === "loading")
    return <Skeleton />;
  switch (loaded.state) {
    case "error":
      return (
        <div className="fv-error" role="alert">
          <p>{loaded.message}</p>
          <button type="button" className="btn-soft" onClick={onRetry}>
            Try again
          </button>
        </div>
      );
    case "none":
      return (
        <div className="fv-note">
          <p>This file type can&apos;t be previewed here.</p>
          {onDownload && (
            <button type="button" className="btn-soft" onClick={onDownload}>
              Download it
            </button>
          )}
        </div>
      );
    case "large":
      return (
        <div className="fv-note">
          <p>This file is too large to preview.</p>
          {onDownload && (
            <button type="button" className="btn-soft" onClick={onDownload}>
              Download it
            </button>
          )}
        </div>
      );
    case "image":
      // A blob: URL of the stored bytes; an image can't run anything.
      return <img className="fv-image" src={loaded.url} alt={name} />;
    case "text":
      return (
        <TextView text={loaded.text} kind={kind} tab={tab} streaming={false} />
      );
  }
}

function TextView({
  text,
  kind,
  tab,
  streaming,
}: {
  text: string;
  kind: ReturnType<typeof previewKind>;
  tab: "preview" | "source";
  streaming: boolean;
}) {
  if (
    tab === "source" ||
    kind === "text" ||
    kind === "none" ||
    kind === "image"
  )
    return <pre className="fv-pre">{text}</pre>;
  if (kind === "markdown")
    return (
      <div className="fv-doc markdown">
        {/* react-markdown renders no raw HTML: model text stays text. */}
        <StreamingMarkdown text={text} streaming={streaming} />
      </div>
    );
  if (kind === "csv") return <CsvGrid text={text} />;
  // HTML: in a frame with no same-origin access and no network. While it is
  // still being written, its source is shown instead of a half page.
  if (streaming) return <pre className="fv-pre">{text}</pre>;
  return (
    <iframe
      className="fv-frame"
      title="HTML preview"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={sandboxedHtml(text)}
    />
  );
}

function CsvGrid({ text }: { text: string }) {
  const { rows, truncated } = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) return <p className="fv-note">This file is empty.</p>;
  const [head, ...body] = rows;
  return (
    <>
      <div className="fv-grid-wrap" tabIndex={0} aria-label="Table">
        <table className="fv-grid">
          <thead>
            <tr>
              {head.map((cell, i) => (
                <th key={i} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td key={i}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="fv-note">
          Showing the first rows and columns. Download for the whole file.
        </p>
      )}
    </>
  );
}

function Skeleton() {
  return (
    <div className="fv-skel" aria-hidden="true">
      <i style={{ width: "62%" }} />
      <i style={{ width: "88%" }} />
      <i style={{ width: "74%" }} />
      <i style={{ width: "81%" }} />
    </div>
  );
}
