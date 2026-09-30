"use client";
import { privacyVM } from "@/lib/vm-insights";
import type { PrivacyReport } from "../../../shared/contracts";
import { ObIcon } from "./ob-icon";

// One row per finding: kind, masked sample, where it was seen and the count.
// Only masked samples ever reach the browser. Renders nothing when empty.
export function PrivacyCard({
  report,
  title = "Privacy on this turn",
}: {
  report: PrivacyReport | PrivacyReport[] | null | undefined;
  title?: string;
}) {
  const vm = privacyVM(Array.isArray(report) ? report : [report]);
  if (!vm.findings.length) return null;
  return (
    <div className="ob-sec">
      <div className="ob-h">
        <ObIcon name="shield" sm />
        {title}
        <span className="ob-r">{vm.summary}</span>
      </div>
      {vm.findings.map((f) => (
        <div className="ob-find" key={f.key}>
          <span className="ob-tile">
            <ObIcon name="shield" />
          </span>
          <div className="ob-find-main">
            <span>
              <b>{f.kind}</b>
              <code aria-label={`Masked sample ${f.sample}`}>{f.sample}</code>
            </span>
            <span>
              <ObIcon name="file" sm />
              {f.source}
            </span>
          </div>
          <span className="ob-cnt">{f.count}</span>
        </div>
      ))}
    </div>
  );
}
