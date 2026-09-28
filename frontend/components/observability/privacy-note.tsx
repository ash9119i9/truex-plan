"use client";
import { useEffect, useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import { scanText } from "../../../shared/privacy.ts";
import { draftNote } from "@/lib/observability";

// A soft heads-up while typing. It never blocks sending; dismissing it hides
// it until the draft is cleared (e.g. after sending).
export function PrivacyNote({ draft }: { draft: string }) {
  const [note, setNote] = useState("");
  const [dismissed, setDismissed] = useState("");
  useEffect(() => {
    if (!draft.trim()) {
      setNote("");
      setDismissed("");
      return;
    }
    const timer = setTimeout(
      () => setNote(draftNote(scanText(draft, "userMessage"))),
      250,
    );
    return () => clearTimeout(timer);
  }, [draft]);
  if (!note || note === dismissed) return null;
  return (
    <div className="obs-draft-note" role="status">
      <ShieldAlert size={14} aria-hidden="true" />
      <span>{note}</span>
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss privacy note"
        onClick={() => setDismissed(note)}
      >
        <X size={13} />
      </button>
    </div>
  );
}
