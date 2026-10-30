import { useId, type CSSProperties } from "react";
import { tintOf } from "@/lib/agent-look";
import { Robot } from "@/components/v2/agent-badge";

// The agent's ID card (DESIGN-SPEC 15.3, 15.4), ported from
// system/screens/agent-id.html. A printed object: the card, chip and metals
// are fixed artwork in every theme (styles/app/agent-card.css). The front is
// who it is; the back is what it can open and what it is good at.
// Not shown until the platform stores them (backlog 11): the ID number, the
// signature and the machine-readable zone.

export type CardAccess = { name: string; write: boolean };

// The card's chip metal: silver in every theme, whatever the model.
const SILVER = ["#F4F7F8", "#C9D1D6", "#97A3AA", "#6B777E"] as const;
// Two rows of server tiles and three rows of skill tags; past that, "+N more".
const MAX_SERVERS = 10;
const MAX_SKILL_TAGS = 6;

// Security engraving for the front: crossing sine lines across the body.
const GUILLOCHE = Array.from({ length: 22 }, (_, i) => {
  let p = "";
  for (let x = -10; x <= 310; x += 5) {
    const y =
      206 +
      i * 9 +
      14 * Math.sin(x / 34 + i * 0.45) +
      6 * Math.sin(x / 13 - i * 0.3);
    p += (x === -10 ? "M" : "L") + x + " " + y.toFixed(1);
  }
  return p;
});

const hash = (s: string) => {
  let h = 2166136261;
  for (const c of s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export const issueDate = (date: Date) =>
  date
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    .toUpperCase();

export function IdCard({
  name,
  handle,
  purpose,
  look,
  tint,
  model,
  issued,
  workspace,
  access,
  skills,
  sig = "",
  guide = "",
  sealed = false,
  face,
}: {
  name: string;
  handle: string;
  purpose: string;
  look: number;
  tint: string;
  model: string;
  /** The issue date, for a card being issued now; absent when not on file. */
  issued?: string;
  workspace: boolean;
  access: CardAccess[];
  skills: string[];
  /** The signature path (240×60 box), or empty when unsigned. */
  sig?: string;
  /** The Guide line, "on-purpose only · 3 rules"; empty to leave it off. */
  guide?: string;
  /** The ISSUED seal has landed: the card was just issued. */
  sealed?: boolean;
  face: "front" | "back";
}) {
  const shownServers =
    access.length > MAX_SERVERS ? MAX_SERVERS - 1 : access.length;
  const shownSkills =
    skills.length > MAX_SKILL_TAGS ? MAX_SKILL_TAGS - 1 : skills.length;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return (
    <div
      className={"idc" + (face === "back" ? " is-back" : "")}
      style={{ "--tint": tintOf(tint).dot } as CSSProperties}
    >
      <div className="idc-face front">
        <Guilloche />
        <span className="badge-slot" />
        <div className="idc-head">
          <span className="idc-brand">
            truex<small>Agent ID</small>
          </span>
          <span className="idc-nfc">
            <Contactless />
          </span>
        </div>
        {sealed && issued && <IssuedSeal date={issued} />}
        <div className="idc-photo">
          <span className="pose-wrap">
            <Robot look={look} size={160} />
          </span>
        </div>
        <div className="idc-who">
          <div
            className={
              "idc-name" +
              (name ? "" : " is-empty") +
              (name.length > 16 ? " is-long" : "")
            }
          >
            {name || "Unnamed"}
          </div>
          <div className="idc-handle">@{handle || "handle"}</div>
          <span className="idc-chip">
            <ChipMark />
          </span>
          <div className={"idc-duty" + (purpose ? "" : " is-empty")}>
            {purpose || "What this specialist owns"}
          </div>
        </div>
        <dl className={"idc-data" + (issued ? "" : " is-two")}>
          <div>
            <dt>Model</dt>
            <dd>{model || "—"}</dd>
          </div>
          {issued && (
            <div>
              <dt>Issued</dt>
              <dd>{issued}</dd>
            </div>
          )}
          <div>
            <dt>Expires</dt>
            <dd>No expiry</dd>
          </div>
        </dl>
        <div className="idc-band">
          <span>
            <b>{workspace ? "Workspace agent" : "Personal agent"}</b>
            <small>
              {workspace ? "Every member can use it" : "Only you can use it"}
            </small>
          </span>
          <Barcode seed={handle || "draft"} />
        </div>
      </div>
      <div className="idc-face back">
        <span className="badge-slot" />
        <div className="bk-head">
          <span className="idc-brand">
            truex<small>Agent ID</small>
          </span>
        </div>
        <section className="bk-sec">
          <div className="bk-h">
            <span>Access</span>
            <span>
              {access.length ? plural(access.length, "server") : "none yet"}
            </span>
          </div>
          <div className="acc-grid">
            {access.slice(0, shownServers).map((a) => (
              <span
                key={a.name}
                className="acc"
                title={`${a.name} · ${a.write ? "read and write" : "read only"}`}
              >
                <span className="acc-logo">
                  <span className="acc-mono" aria-hidden="true">
                    {a.name.charAt(0).toUpperCase()}
                  </span>
                  {a.write && <span className="acc-w">R/W</span>}
                </span>
                <span className="acc-n">{a.name}</span>
              </span>
            ))}
            {access.length > shownServers && (
              <span className="acc more">
                <span className="acc-logo">
                  +{access.length - shownServers}
                </span>
                <span className="acc-n">more</span>
              </span>
            )}
            {Array.from({ length: Math.max(0, 5 - access.length) }, (_, i) => (
              <span key={"slot" + i} className="acc slot" aria-hidden="true">
                <span className="acc-logo" />
              </span>
            ))}
          </div>
        </section>
        <section className="bk-sec">
          <div className="bk-h">
            <span>Skills</span>
            <span>
              {skills.length ? plural(skills.length, "skill") : "none yet"}
            </span>
          </div>
          <div className="sk-list">
            {skills.length ? (
              <>
                {skills.slice(0, shownSkills).map((s) => (
                  <span key={s} className="sk">
                    {s}
                  </span>
                ))}
                {skills.length > shownSkills && (
                  <span className="sk more">
                    +{skills.length - shownSkills} more
                  </span>
                )}
              </>
            ) : (
              <span className="sk slot">No skills yet</span>
            )}
          </div>
        </section>
        <div className="bk-mark" aria-hidden="true">
          <span>{workspace ? "Workspace agent" : "Personal agent"}</span>
        </div>
        <div className="bk-sign">
          <div className="sig-strip">
            {sig ? (
              <svg key={sig} viewBox="0 0 240 60" aria-hidden="true">
                <path d={sig} pathLength={1} />
              </svg>
            ) : (
              <span className="sig-empty">Not yet signed</span>
            )}
          </div>
          <div className="sig-cap">
            <span>Authorised signature</span>
            <span>Not valid unless signed</span>
          </div>
        </div>
        <div className="bk-fine">
          <span className="bk-rules">
            <b>Limits</b>
            {limitsOf(access)}
          </span>
          {guide && (
            <span className="bk-rules">
              <b>Guide</b>
              {guide}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// The access rule in plain words (spec 15.3: "read only, everywhere").
export function limitsOf(access: CardAccess[]): string {
  if (!access.length) return "no access granted yet";
  const write = access.filter((a) => a.write).map((a) => a.name);
  if (!write.length) return "read only, everywhere";
  if (write.length === access.length) return "may write wherever it can open";
  const list =
    write.length < 3
      ? write.join(" and ")
      : `${write.slice(0, 2).join(", ")} and ${write.length - 2} more`;
  return `read only, except ${list}`;
}

function Guilloche() {
  return (
    <svg
      className="guil"
      viewBox="0 0 300 476"
      preserveAspectRatio="none"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      {GUILLOCHE.map((p, i) => (
        <path key={i} d={p} strokeWidth=".5" />
      ))}
    </svg>
  );
}

// Decorative bars, like a printed badge. Not scannable.
function Barcode({
  seed,
  w = 78,
  h = 22,
}: {
  seed: string;
  w?: number;
  h?: number;
}) {
  const bars: [number, number][] = [];
  for (let x = 0, i = 0; x < w; i++) {
    const n = hash(seed + i);
    const bw = 1 + (n % 3) * 0.7;
    if (x + bw > w) break;
    bars.push([x, bw]);
    x += bw + 1 + ((n >> 4) % 3) * 0.6;
  }
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      fill="currentColor"
      aria-hidden="true"
    >
      {bars.map(([x, bw], i) => (
        <rect key={i} x={x} y="0" width={bw} height={h} />
      ))}
    </svg>
  );
}

// Embossed in the chip's silver when the card is issued; it lands on the
// photo's lower corner (spec 15.3: an "ISSUED · ‹date›" foil seal).
function IssuedSeal({ date }: { date: string }) {
  const id = "is" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [hi, mid, lo, ink] = SILVER;
  return (
    <svg
      className="issued-seal"
      width="64"
      height="64"
      viewBox="0 0 64 64"
      role="img"
      aria-label={`Issued ${date}`}
    >
      <defs>
        <linearGradient id={id + "g"} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={hi} />
          <stop offset=".5" stopColor={mid} />
          <stop offset="1" stopColor={lo} />
        </linearGradient>
        <path id={id + "p"} d="M32 12a20 20 0 1 1 0 40a20 20 0 1 1 0-40" />
      </defs>
      <circle
        cx="32"
        cy="32"
        r="31"
        fill={`url(#${id}g)`}
        stroke={ink}
        strokeOpacity=".6"
      />
      <circle
        cx="32"
        cy="32"
        r="26.5"
        fill="none"
        stroke={ink}
        strokeOpacity=".4"
        strokeDasharray="1 2"
      />
      <text
        fontFamily="Geist Mono, ui-monospace, monospace"
        fontSize="5.4"
        fontWeight="700"
        letterSpacing="2"
        fill={ink}
      >
        <textPath href={`#${id}p`}>ISSUED · {date} · </textPath>
      </text>
      <circle
        cx="32"
        cy="32"
        r="11"
        fill="none"
        stroke={ink}
        strokeOpacity=".55"
      />
      <path
        d="M26.8 32.4l3.6 3.6 7-7.6"
        fill="none"
        stroke={ink}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11 24c4-8 12-13 21-13"
        fill="none"
        stroke="#fff"
        strokeOpacity=".65"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChipMark({ w = 40 }: { w?: number }) {
  const id = "ch" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [m0, m1, m2, m3] = SILVER;
  return (
    <svg
      width={w}
      height={(w * 36) / 46}
      viewBox="0 0 46 36"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={m0} />
          <stop offset=".5" stopColor={m1} />
          <stop offset="1" stopColor={m2} />
        </linearGradient>
      </defs>
      <rect
        x=".5"
        y=".5"
        width="45"
        height="35"
        rx="7"
        fill={`url(#${id})`}
        stroke={m3}
        strokeOpacity=".7"
      />
      <path
        d="M0 12h14M0 24h14M32 12h14M32 24h14M14 0v10M14 26v10M32 0v10M32 26v10"
        stroke={m3}
        strokeOpacity=".55"
        fill="none"
      />
      <rect
        x="14"
        y="10"
        width="18"
        height="16"
        rx="3.5"
        fill="none"
        stroke={m3}
        strokeOpacity=".6"
      />
      <path
        d="M5 5c4-2.6 10-3 15-2"
        stroke="#fff"
        strokeOpacity=".7"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function Contactless() {
  return (
    <svg
      width="16"
      height="18"
      viewBox="0 0 16 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 6.5a4 4 0 0 1 0 5M6.5 4a8 8 0 0 1 0 10M10 1.5a12 12 0 0 1 0 15" />
    </svg>
  );
}
