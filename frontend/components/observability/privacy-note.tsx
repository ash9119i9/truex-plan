"use client";
import { useEffect, useState } from "react";
// No shield in the v2 icon set, so lucide stays for the warning mark.
import { ShieldAlert } from "lucide-react";
import { Icon } from "../v2/icon";
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
    <div className="composer-note is-warn" role="status">
      <ShieldAlert size={14} aria-hidden="true" />
      <span>{note}</span>
      <button
        type="button"
        className="icon-btn ghost"
        aria-label="Dismiss privacy note"
        onClick={() => setDismissed(note)}
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
