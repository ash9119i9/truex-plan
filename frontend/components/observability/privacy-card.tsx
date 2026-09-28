"use client";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { describeFinding } from "../../../shared/privacy.ts";
import type { PrivacyReport } from "../../../shared/contracts";

// Was my data safe: what pattern checks detected in text the model saw.
// Only masked samples are ever shown; the raw values never reach the browser.
export function PrivacyCard({ report }: { report: PrivacyReport }) {
  const findings = report?.findings || [];
  if (!findings.length)
    return (
      <div className="obs-privacy">
        <p className="obs-privacy-head">
          <ShieldCheck size={15} aria-hidden="true" /> No personal data detected
        </p>
        <p className="obs-note">
          Checked {report?.scannedChars?.toLocaleString() ?? 0} characters for
          emails, phone numbers, card and account numbers, IDs and access keys.
          Pattern checks can miss things.
        </p>
      </div>
    );
  return (
    <div className="obs-privacy warn">
      <p className="obs-privacy-head">
        <ShieldAlert size={15} aria-hidden="true" /> Personal data detected
      </p>
      <ul>
        {findings.map((f) => (
          <li key={`${f.kind}:${f.source}`}>
            <span>{describeFinding(f)}</span>
            <code aria-label={`Masked sample ${f.sample}`}>{f.sample}</code>
          </li>
        ))}
      </ul>
      <p className="obs-note">
        This was sent to the model as part of the turn. Samples are masked.
      </p>
    </div>
  );
}
