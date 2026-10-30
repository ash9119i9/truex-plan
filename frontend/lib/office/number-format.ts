// A cell's number as Excel would show it, from its number format code. Covers
// the built-in formats and the common custom ones (fixed decimals, grouping,
// percent, currency, scientific, dates and times); anything it can't read is
// shown as General.

const BUILTIN: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "General",
  13: "General",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;(#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;(#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
  48: "##0.0E+0",
  49: "@",
};

export function formatCode(id: number, custom: ReadonlyMap<number, string>) {
  return custom.get(id) ?? BUILTIN[id] ?? "General";
}

export function formatNumber(value: number, code: string, date1904 = false) {
  const sections = splitSections(code);
  let section = sections[0] ?? "General";
  let shown = value;
  if (value < 0 && sections[1]) {
    section = sections[1];
    shown = -value;
  } else if (value === 0 && sections[2]) section = sections[2];
  const trimmed = section.trim();
  if (!trimmed || /^general$/i.test(trimmed) || trimmed === "@")
    return general(shown);
  if (isDate(section)) return formatDate(value, section, date1904);
  return formatPlain(shown, section);
}

// Up to 10 significant digits, scientific for very large or small numbers.
export function general(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (Number.isInteger(value) && abs < 1e11) return String(value);
  if (abs >= 1e11 || (abs > 0 && abs < 1e-9)) return scientific(value, 5, true);
  return String(Number(value.toPrecision(10)));
}

function splitSections(code: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "\\" && !quoted) {
      current += c + (code[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "[") bracket = true;
    else if (!quoted && c === "]") bracket = false;
    else if (!quoted && !bracket && c === ";") {
      out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

// Date or time: y, m, d, h or s outside quotes, escapes and [colour] brackets.
function isDate(section: string): boolean {
  const bare = section
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "")
    .replace(/[_*]./g, "");
  return /[ymdhs]/i.test(bare);
}

function scientific(value: number, digits: number, trim: boolean): string {
  const [mantissa, exponent] = value.toExponential(digits).split("e");
  const m = trim ? String(Number(mantissa)) : mantissa;
  const sign = exponent.startsWith("-") ? "-" : "+";
  return `${m}E${sign}${exponent.replace(/^[+-]/, "").padStart(2, "0")}`;
}

function formatPlain(value: number, section: string): string {
  let prefix = "";
  let suffix = "";
  let core = "";
  let percent = 0;
  const literal = (text: string) => {
    if (core) suffix += text;
    else prefix += text;
  };
  for (let i = 0; i < section.length; i++) {
    const c = section[i];
    if (c === '"') {
      const end = section.indexOf('"', i + 1);
      literal(section.slice(i + 1, end < 0 ? undefined : end));
      i = end < 0 ? section.length : end;
    } else if (c === "\\") literal(section[++i] ?? "");
    else if (c === "_" || c === "*") i++;
    else if (c === "[") {
      const end = section.indexOf("]", i);
      const inner = section.slice(i + 1, end < 0 ? undefined : end);
      // [$€-407]: a currency symbol; other brackets are colours or conditions.
      if (inner.startsWith("$")) literal(inner.slice(1).split("-")[0]);
      i = end < 0 ? section.length : end;
    } else if (/[0#?.,]/.test(c) && !suffix) core += c;
    else if (/[eE]/.test(c) && core && /[+-]/.test(section[i + 1] ?? "")) {
      let j = i + 2;
      while (section[j] === "0") j++;
      core += section.slice(i, j);
      i = j - 1;
    } else if (c === "%") {
      percent++;
      literal("%");
    } else literal(c);
  }
  let shown = value * 100 ** percent;
  const [mantissa, exponent] = core.split(/[eE][+-]/);
  const [whole = "", fraction = ""] = mantissa.split(".");
  const min = (fraction.match(/0/g) ?? []).length;
  const max = (fraction.match(/[0#?]/g) ?? []).length;
  if (exponent !== undefined)
    return prefix + scientific(shown, max, false) + suffix;
  // Trailing commas scale by thousands: "0," shows 1500 as 2.
  const scale = (whole.match(/,+$/)?.[0] ?? "").length;
  shown /= 1000 ** scale;
  const digits = whole.slice(0, whole.length - scale);
  if (!/[0#?]/.test(digits) && !max) return prefix + suffix;
  let text = Math.abs(shown).toLocaleString("en-US", {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
    minimumIntegerDigits: Math.min(
      21,
      Math.max(1, (digits.match(/0/g) ?? []).length),
    ),
    useGrouping: digits.includes(","),
  });
  // "#" and "?" show no digit for a zero whole part: "#.##" shows 0.5 as ".5".
  if (!digits.includes("0") && /^0(?!\d)/.test(text)) text = text.slice(1);
  const negative = shown < 0 && /[1-9]/.test(text);
  return (negative ? "-" : "") + prefix + text + suffix;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

type Token =
  | { kind: "text"; text: string }
  | { kind: "y" | "m" | "d" | "h" | "s" | "minute"; length: number }
  | { kind: "ampm"; short: boolean }
  | { kind: "fraction"; length: number }
  | { kind: "elapsed"; unit: "h" | "m" | "s"; length: number };

function tokenize(section: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < section.length; i++) {
    const c = section[i];
    const rest = section.slice(i);
    if (c === '"') {
      const end = section.indexOf('"', i + 1);
      tokens.push({
        kind: "text",
        text: section.slice(i + 1, end < 0 ? undefined : end),
      });
      i = end < 0 ? section.length : end;
    } else if (c === "\\")
      tokens.push({ kind: "text", text: section[++i] ?? "" });
    else if (c === "_" || c === "*") i++;
    else if (c === "[") {
      const end = section.indexOf("]", i);
      const inner = section.slice(i + 1, end < 0 ? undefined : end);
      if (/^(h+|m+|s+)$/i.test(inner))
        tokens.push({
          kind: "elapsed",
          unit: inner[0].toLowerCase() as "h" | "m" | "s",
          length: inner.length,
        });
      i = end < 0 ? section.length : end;
    } else if (/^am\/pm/i.test(rest)) {
      tokens.push({ kind: "ampm", short: false });
      i += 4;
    } else if (/^a\/p/i.test(rest)) {
      tokens.push({ kind: "ampm", short: true });
      i += 2;
    } else if (/[ymdhs]/i.test(c)) {
      let j = i;
      while (j < section.length && section[j].toLowerCase() === c.toLowerCase())
        j++;
      tokens.push({ kind: c.toLowerCase() as "y", length: j - i });
      i = j - 1;
    } else if (c === "." && section[i + 1] === "0") {
      let j = i + 1;
      while (section[j] === "0") j++;
      tokens.push({ kind: "fraction", length: j - i - 1 });
      i = j - 1;
    } else tokens.push({ kind: "text", text: c });
  }
  // "m" after an hour or before a second is minutes, not the month.
  const units = tokens.filter((t) => t.kind !== "text");
  units.forEach((token, at) => {
    if (token.kind !== "m" || token.length > 2) return;
    const before = units[at - 1];
    const after = units[at + 1];
    if (
      (before &&
        (before.kind === "h" ||
          (before.kind === "elapsed" && before.unit === "h"))) ||
      (after &&
        (after.kind === "s" ||
          (after.kind === "elapsed" && after.unit === "s")))
    )
      (token as { kind: string }).kind = "minute";
  });
  return tokens;
}

function formatDate(
  serial: number,
  section: string,
  date1904: boolean,
): string {
  // Excel's calendar ends on 9999-12-31; it shows ##### past that.
  if (serial < 0 || serial >= 2_958_466) return general(serial);
  const tokens = tokenize(section);
  const fraction = tokens.find((t) => t.kind === "fraction");
  let days = Math.floor(serial);
  const unit = fraction ? 1 : 1000;
  let ms = Math.round(((serial - days) * 86_400_000) / unit) * unit;
  if (ms >= 86_400_000) {
    days++;
    ms -= 86_400_000;
  }
  let y: number, mo: number, d: number, dow: number;
  if (!date1904 && days === 60) [y, mo, d, dow] = [1900, 2, 29, 3];
  else {
    // The 1900 system counts a 29 February 1900 that never was (Lotus 1-2-3).
    const base = date1904
      ? Date.UTC(1904, 0, 1)
      : days < 60
        ? Date.UTC(1899, 11, 31)
        : Date.UTC(1899, 11, 30);
    const date = new Date(base + days * 86_400_000);
    [y, mo, d, dow] = [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCDay(),
    ];
  }
  const h = Math.floor(ms / 3_600_000);
  const mi = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const twelve = tokens.some((t) => t.kind === "ampm");
  const pad = (n: number, length: number) => String(n).padStart(length, "0");
  return tokens
    .map((t) => {
      switch (t.kind) {
        case "text":
          return t.text;
        case "y":
          return t.length <= 2 ? pad(y % 100, 2) : pad(y, 4);
        case "m":
          return t.length === 1
            ? String(mo)
            : t.length === 2
              ? pad(mo, 2)
              : t.length === 3
                ? MONTHS[mo - 1].slice(0, 3)
                : t.length === 4
                  ? MONTHS[mo - 1]
                  : MONTHS[mo - 1][0];
        case "minute":
          return pad(mi, t.length);
        case "d":
          return t.length <= 2
            ? pad(d, t.length)
            : t.length === 3
              ? DAYS[dow].slice(0, 3)
              : DAYS[dow];
        case "h":
          return pad(twelve ? h % 12 || 12 : h, Math.min(2, t.length));
        case "s":
          return pad(s, Math.min(2, t.length));
        case "ampm":
          return t.short ? (h < 12 ? "A" : "P") : h < 12 ? "AM" : "PM";
        case "fraction":
          return (
            "." +
            pad(ms % 1000, 3)
              .slice(0, t.length)
              .padEnd(t.length, "0")
          );
        case "elapsed": {
          const total = days * 86_400_000 + ms;
          const value =
            t.unit === "h"
              ? Math.floor(total / 3_600_000)
              : t.unit === "m"
                ? Math.floor(total / 60_000)
                : Math.floor(total / 1000);
          return pad(value, t.length);
        }
      }
    })
    .join("");
}
