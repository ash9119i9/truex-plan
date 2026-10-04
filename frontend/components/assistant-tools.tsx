"use client";
import { useCallback, useEffect, useState } from "react";
import { FileText, Upload, Download } from "lucide-react";
import {
  assistantCapabilities,
  webReadAvailabilityMessage,
  webCrawlAvailabilityMessage,
  type ConversationFile,
} from "../../shared/assistant-capabilities";
import { api, base } from "@/lib/api";
import { documentKind, uploadAccept } from "@/lib/document-kind";
import { DocumentIcon } from "./document-icon";
import { Button } from "./ui/button";
import { QuickTools } from "./quick-tools";
import { Visualization } from "./visualization";
import { CrawlJobs } from "./crawl-jobs";

export function AssistantTools({
  sessionId,
  refreshKey,
  running,
  onPrompt,
  onFork,
}: {
  sessionId?: string;
  refreshKey: number;
  running: boolean;
  onPrompt: (text: string) => void;
  onFork: (id: string) => void;
}) {
  const [files, setFiles] = useState<ConversationFile[]>([]);
  const [available, setAvailable] = useState(false);
  const [visualizationAvailable, setVisualizationAvailable] = useState(false);
  const [webSearchAvailable, setWebSearchAvailable] = useState<boolean | null>(
    null,
  );
  const [webReadAvailable, setWebReadAvailable] = useState<boolean | null>(
    null,
  );
  const [webCrawlAvailable, setWebCrawlAvailable] = useState<boolean | null>(
    null,
  );
  const [selectedVisual, setSelectedVisual] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const data = await api(`/api/sessions/${sessionId}/documents`);
    setFiles(data.files);
    setAvailable(data.available);
    setVisualizationAvailable(data.visualizationAvailable === true);
    setWebSearchAvailable(data.webSearchAvailable === true);
    setWebReadAvailable(data.webReadAvailable === true);
    setWebCrawlAvailable(data.webCrawlAvailable === true);
  }, [sessionId]);
  useEffect(() => {
    let cancelled = false;
    setWebSearchAvailable(null);
    setWebReadAvailable(null);
    setWebCrawlAvailable(null);
    if (!sessionId) {
      setFiles([]);
      setAvailable(false);
      return;
    }
    api(`/api/sessions/${sessionId}/documents`)
      .then((data) => {
        if (!cancelled) {
          setFiles(data.files);
          setAvailable(data.available);
          setVisualizationAvailable(data.visualizationAvailable === true);
          setWebSearchAvailable(data.webSearchAvailable === true);
          setWebReadAvailable(data.webReadAvailable === true);
          setWebCrawlAvailable(data.webCrawlAvailable === true);
          setError("");
        }
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);
  async function upload(file: File) {
    if (!sessionId) return;
    setBusy(true);
    setError("");
    try {
      if (file.size > 1048576)
        throw new Error("Choose a document of up to 1 MB.");
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () =>
          reject(new Error("Could not read this document."));
        reader.readAsDataURL(file);
      });
      await api(`/api/sessions/${sessionId}/documents`, {
        name: file.name,
        base64,
      });
      await refresh();
      onPrompt(
        `Read the uploaded document "${file.name}" and summarize its key points.`,
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="assistant-tools">
      <div className="assistant-tools-body">
        <h3>Capabilities</h3>
        <div className="capability-grid">
          {assistantCapabilities.map((capability) => (
            <button
              type="button"
              key={capability.id}
              onClick={() => onPrompt(capability.prompt)}
            >
              <strong>{capability.name}</strong>
              <span>{capability.description}</span>
              {capability.id === "web" && webSearchAvailable !== null && (
                <span>
                  {webSearchAvailable
                    ? "Built-in WebSearch is available in this conversation."
                    : "Built-in WebSearch is unavailable in this conversation. Provider or connected web tools may still be available."}
                </span>
              )}
              {capability.id === "webRead" && webReadAvailable !== null && (
                <span>{webReadAvailabilityMessage(webReadAvailable)}</span>
              )}
              {capability.id === "webCrawl" && webCrawlAvailable !== null && (
                <span>{webCrawlAvailabilityMessage(webCrawlAvailable)}</span>
              )}
            </button>
          ))}
        </div>
        <CrawlJobs
          key={sessionId || "new"}
          sessionId={sessionId}
          refreshKey={refreshKey}
          onPrompt={onPrompt}
        />
        <section
          aria-label="Conversation documents"
          className="conversation-documents"
        >
          <h3>
            <FileText size={16} /> Documents
          </h3>
          {!sessionId ? (
            <p className="muted">
              Send your first message to start a conversation, then upload
              documents here.
            </p>
          ) : !available ? (
            <p className="muted">
              Start a new conversation to enable document tools.
            </p>
          ) : (
            <>
              <label className="document-upload">
                <Upload size={15} /> {busy ? "Uploading…" : "Upload a document"}
                <input
                  type="file"
                  aria-label="Upload a document"
                  accept={uploadAccept}
                  disabled={busy || running}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void upload(file);
                  }}
                />
              </label>
              <p className="muted">
                PDF, Word, Excel, PowerPoint, text, or code · 1 MB per file.
                Revisions create a new version; original formatting may change.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void refresh().catch((error) => setError(error.message))
                }
              >
                Refresh documents
              </Button>
            </>
          )}
          {files
            .filter((file) => file.kind !== "visualization")
            .map((file) => (
              <div className="document-row" key={file.id}>
                <DocumentIcon name={file.name} size={16} />
                <div>
                  <strong>{file.name}</strong>
                  <small>
                    {documentKind(file.name).label} ·{" "}
                    {Math.ceil(file.size / 1024)} KB
                    {file.sourceId ? " · Revised version" : ""}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onPrompt(
                      `Read the document "${file.name}" (file ID ${file.id}) and help me with: `,
                    )
                  }
                >
                  Discuss
                </button>
                <a
                  href={`${base}/api/sessions/${sessionId}/documents/${file.id}`}
                  download={file.name}
                  aria-label={`Download ${file.name}`}
                >
                  <Download size={16} /> Download
                </a>
              </div>
            ))}
        </section>
        <section
          className="conversation-visualizations"
          aria-label="Saved visualizations"
        >
          <h3>Visualize</h3>
          {sessionId && !visualizationAvailable && (
            <p className="muted">
              Start a new conversation to enable Visualize.
            </p>
          )}
          <p className="muted">
            Ask Truex to visualize a concept, compare data, or build an
            interactive explanation.
          </p>
          {files
            .filter((file) => file.kind === "visualization")
            .map((file) => (
              <div className="document-row" key={file.id}>
                <div>
                  <strong>{file.title}</strong>
                  {file.sourceId && <small>Revised version</small>}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setSelectedVisual(
                      selectedVisual === file.id ? null : file.id,
                    )
                  }
                >
                  {selectedVisual === file.id ? "Hide visual" : "Open visual"}
                </Button>
              </div>
            ))}
          {sessionId && selectedVisual && (
            <Visualization
              key={selectedVisual}
              sessionId={sessionId}
              id={selectedVisual}
              onPrompt={onPrompt}
            />
          )}
        </section>
        {sessionId && (
          <QuickTools
            key={sessionId}
            sessionId={sessionId}
            onFork={onFork}
            disabled={running}
            refreshKey={refreshKey}
          />
        )}
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
