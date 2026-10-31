"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { Button } from "@/components/tx/button";
import { type ChatFile, type ViewerTarget } from "@/lib/tenant-files";
import { DocumentCard } from "./document-card";

export type { ViewerTarget };

export interface FileActions {
  open: (target: ViewerTarget) => void;
  // A stored version's bytes, from the open chat (cached).
  content: (fileId: string) => Promise<Blob>;
  download: (file: ChatFile) => void;
  // The target the viewer shows now, so its row is highlighted.
  active: ViewerTarget | null;
  // Saves a reply's unsaved files (`paths`, as the card shows them) again.
  retry: (runId: string, paths: readonly string[]) => void;
  // A reply's retry in progress, or why the last one didn't finish.
  retryState: (runId: string) => RetryState | undefined;
}

export type RetryState = { busy: true } | { busy: false; message: string };

export const FileActionsContext = createContext<FileActions | null>(null);

// An object URL for `blob` while the caller is mounted; revoked after.
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return url;
}

// An image file's bytes: the given blob, or a saved version's loaded through
// the file actions. "failed" when it can't be loaded (or there is nothing to
// load); the caller then shows the file's tile instead.
export function useImageBlob(
  blob: Blob | undefined,
  fileId: string | undefined,
): Blob | "loading" | "failed" {
  const actions = useContext(FileActionsContext);
  const load = actions?.content;
  const [loaded, setLoaded] = useState<{
    id: string;
    blob: Blob | "failed";
  } | null>(null);
  useEffect(() => {
    if (blob || !fileId || !load) return;
    let current = true;
    load(fileId).then(
      (bytes) => current && setLoaded({ id: fileId, blob: bytes }),
      () => current && setLoaded({ id: fileId, blob: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [blob, fileId, load]);
  if (blob) return blob;
  if (!fileId || !load) return "failed";
  return loaded && loaded.id === fileId ? loaded.blob : "loading";
}

// Rows shown before "+N more".
const SHOWN = 3;

export interface WritingFile {
  path: string;
}

// The files a reply made, under its last paragraph, as DocumentCards
// (DESIGN-SPEC 12.3): each opens the viewer and has its own Download. A file still being written shows Writing…
// and can be opened to watch it. A file that couldn't be saved says so,
// with Retry; it has nothing to open or download until it is saved.
export function FileCard({
  runId,
  files,
  writing,
  unsaved = [],
  tooLarge = [],
  truncated = false,
}: {
  runId: string;
  files: readonly ChatFile[];
  writing: readonly WritingFile[];
  unsaved?: readonly string[];
  // Files over the per-file limit: shown, never retried.
  tooLarge?: readonly string[];
  // The chat had more files than could be checked, so some may be missing.
  truncated?: boolean;
}) {
  const actions = useContext(FileActionsContext);
  const [expanded, setExpanded] = useState(false);
  if (!actions) return null;
  const stored = new Set(files.map((f) => f.path));
  const big = tooLarge.filter((path) => !stored.has(path));
  const bigSet = new Set(big);
  const failed = unsaved.filter(
    (path) => !stored.has(path) && !bigSet.has(path),
  );
  const failedSet = new Set(failed);
  const rows: Array<
    | { kind: "file"; file: ChatFile }
    | { kind: "writing"; path: string }
    | { kind: "unsaved"; path: string }
    | { kind: "tooLarge"; path: string }
  > = [
    ...files.map((file) => ({ kind: "file" as const, file })),
    ...failed.map((path) => ({ kind: "unsaved" as const, path })),
    ...big.map((path) => ({ kind: "tooLarge" as const, path })),
    ...writing
      .filter(
        (w) =>
          !stored.has(w.path) && !failedSet.has(w.path) && !bigSet.has(w.path),
      )
      .map((w) => ({ kind: "writing" as const, path: w.path })),
  ];
  if (rows.length === 0 && !truncated) return null;
  const total = rows.length;
  const ready = files.length;
  const visible = expanded ? rows : rows.slice(0, SHOWN);
  const retry = actions.retryState(runId);
  const noun = total === 1 ? "file" : "files";
  const heading =
    ready === total
      ? `${total} ${noun}`
      : failed.length + big.length > 0
        ? `${total} ${noun} · ${failed.length + big.length} not saved`
        : `${total} ${noun} · ${ready} ready`;
  const isActive = (path: string) =>
    actions.active?.runId === runId && actions.active.path === path;
  return (
    <section className="dc-stack" aria-label="Files from this reply">
      {ready !== total && <p className="dc-stack-head">{heading}</p>}
      {visible.map((row) => {
        const path = row.kind === "file" ? row.file.path : row.path;
        const name = path.slice(path.lastIndexOf("/") + 1);
        if (row.kind === "tooLarge")
          return (
            <DocumentCard key={path} name={name} size={0} state="tooLarge" />
          );
        if (row.kind === "unsaved")
          return (
            <DocumentCard
              key={path}
              name={name}
              size={0}
              state={retry?.busy ? "saving" : "unsaved"}
              onRetry={() => actions.retry(runId, failed)}
            />
          );
        return (
          <DocumentCard
            key={path}
            name={name}
            size={row.kind === "file" ? row.file.size : 0}
            version={row.kind === "file" ? row.file.version : undefined}
            state={row.kind === "file" ? "ready" : "writing"}
            active={isActive(path)}
            onOpen={() => actions.open({ runId, path })}
            onDownload={
              row.kind === "file" ? () => actions.download(row.file) : undefined
            }
          />
        );
      })}
      {retry && !retry.busy && (
        <p className="dc-stack-note" role="alert">
          {retry.message}
        </p>
      )}
      {truncated && (
        <p className="dc-stack-note">
          This chat has too many files to check them all, so some files from
          this reply may be missing here.
        </p>
      )}
      {rows.length > SHOWN && (
        <Button
          size="xs"
          variant="ghost"
          className="dc-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show fewer" : `+${rows.length - SHOWN} more`}
        </Button>
      )}
    </section>
  );
}
