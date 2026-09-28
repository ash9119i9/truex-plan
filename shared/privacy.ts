// Pattern-based personal/sensitive data detection for text fed to the model.
// Findings never hold raw values: only kind, source, count and a masked sample.
// Plain TypeScript (no enums/namespaces) so the frontend can strip-types it.
import type {
  PrivacyFinding,
  PrivacyKind,
  PrivacyReport,
  PrivacySource,
} from "./contracts";

// Longest text scanned per call; the rest is ignored rather than slowing turns.
export const MAX_SCAN_CHARS = 200_000;

interface Detector {
  kind: PrivacyKind;
  pattern: RegExp;
  valid?: (match: string) => boolean;
}

const digits = (s: string) => s.replace(/\D/g, "");

function luhn(value: string) {
  const d = digits(value);
  if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

function iban(value: string) {
  const v = value.replace(/\s/g, "").toUpperCase();
  const moved = v.slice(4) + v.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const code = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of code) rest = (rest * 10 + Number(c)) % 97;
  }
  return rest === 1;
}

// Verhoeff checksum, which every Aadhaar number carries.
const vD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const vP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
function verhoeff(value: string) {
  const d = digits(value);
  let c = 0;
  for (let i = 0; i < d.length; i++)
    c = vD[c][vP[i % 8][Number(d[d.length - 1 - i])]];
  return c === 0;
}

function ipv4(value: string) {
  const parts = value.split(".").map(Number);
  if (parts.some((n) => n > 255)) return false;
  // Loopback and unspecified addresses identify no one.
  return parts[0] !== 127 && parts[0] !== 0;
}

// Order matters: earlier detectors claim their span so later ones skip it
// (a card number is not also reported as a phone number).
const detectors: Detector[] = [
  {
    kind: "secret",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  },
  {
    kind: "card",
    pattern: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    valid: luhn,
  },
  {
    kind: "iban",
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
    valid: iban,
  },
  {
    kind: "aadhaar",
    pattern: /(?<!\d)[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?!\d)/g,
    valid: verhoeff,
  },
  {
    kind: "ssn",
    pattern: /(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/g,
  },
  { kind: "pan", pattern: /\b[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z]\b/g },
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: "ip",
    pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    valid: ipv4,
  },
  {
    kind: "phone",
    // International (+CC ...), North American (xxx) xxx-xxxx, or Indian mobile.
    pattern:
      /(?<![\w+])(?:\+\d{1,3}[ .-]?(?:\(?\d{1,4}\)?[ .-]?)?\d{3,4}[ .-]?\d{3,4}|\(\d{3}\)[ .-]?\d{3}[ .-]?\d{4}|\d{3}[.-]\d{3}[.-]\d{4}|[6-9]\d{9})(?![\w])/g,
    valid: (m) => {
      const n = digits(m).length;
      return n >= 10 && n <= 15;
    },
  },
];

export const privacyLabels: Record<PrivacyKind, string> = {
  email: "email address",
  phone: "phone number",
  card: "card number",
  iban: "bank account (IBAN)",
  ssn: "social security number",
  aadhaar: "Aadhaar number",
  pan: "PAN number",
  ip: "IP address",
  secret: "secret or access key",
};

// A sample that shows the shape of what was found, never enough to use it.
export function maskValue(kind: PrivacyKind, value: string) {
  if (kind === "email") {
    const [user, domain = ""] = value.split("@");
    const tld = domain.includes(".") ? domain.slice(domain.lastIndexOf(".")) : "";
    return `${user[0] ?? ""}***@***${tld}`;
  }
  if (kind === "secret") return `${value.slice(0, 3)}***`;
  if (kind === "ip") return `${value.split(".")[0]}.***.***.***`;
  if (kind === "pan") return `*****${value.slice(-1)}`.padStart(10, "*");
  const d = digits(value) || value;
  return `••••${d.slice(-2)}`;
}

interface Hit {
  kind: PrivacyKind;
  start: number;
  end: number;
  value: string;
}

function detect(text: string): Hit[] {
  const input = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const hits: Hit[] = [];
  const taken = (s: number, e: number) =>
    hits.some((h) => s < h.end && e > h.start);
  for (const d of detectors) {
    d.pattern.lastIndex = 0;
    for (const m of input.matchAll(d.pattern)) {
      const start = m.index ?? 0,
        end = start + m[0].length;
      if (taken(start, end)) continue;
      if (d.valid && !d.valid(m[0])) continue;
      hits.push({ kind: d.kind, start, end, value: m[0] });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

// Findings for one piece of text, grouped by kind.
export function scanText(text: string, source: PrivacySource): PrivacyFinding[] {
  if (!text) return [];
  const byKind = new Map<PrivacyKind, PrivacyFinding>();
  for (const h of detect(text)) {
    const f = byKind.get(h.kind);
    if (f) f.count++;
    else
      byKind.set(h.kind, {
        kind: h.kind,
        source,
        count: 1,
        sample: maskValue(h.kind, h.value),
      });
  }
  return [...byKind.values()];
}

// The text with every detected value replaced by its masked sample.
export function maskText(text: string) {
  if (!text) return text;
  let out = "",
    at = 0;
  for (const h of detect(text)) {
    out += text.slice(at, h.start) + maskValue(h.kind, h.value);
    at = h.end;
  }
  return out + text.slice(at);
}

// Merges findings from many texts: one row per kind and source.
export function mergeFindings(...lists: PrivacyFinding[][]): PrivacyFinding[] {
  const merged = new Map<string, PrivacyFinding>();
  for (const list of lists)
    for (const f of list) {
      const key = `${f.kind}:${f.source}`;
      const prev = merged.get(key);
      if (prev) prev.count += f.count;
      else merged.set(key, { ...f });
    }
  return [...merged.values()];
}

export function emptyReport(): PrivacyReport {
  return { scannedChars: 0, findings: [] };
}

// Adds one text's findings to a running report, in place.
export function addToReport(
  report: PrivacyReport,
  text: string,
  source: PrivacySource,
) {
  if (!text) return report;
  report.scannedChars += Math.min(text.length, MAX_SCAN_CHARS);
  report.findings = mergeFindings(report.findings, scanText(text, source));
  return report;
}

// "1 email address in a tool output" style one-liners for the UI.
const sourceLabels: Record<PrivacySource, string> = {
  userMessage: "your message",
  toolOutput: "a tool output",
  command: "a command",
  fileContent: "file content",
  assistant: "the reply",
};
export function describeFinding(f: PrivacyFinding) {
  const label = privacyLabels[f.kind];
  return `${f.count} ${label}${f.count > 1 ? "s" : ""} in ${sourceLabels[f.source]}`;
}
