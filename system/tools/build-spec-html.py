#!/usr/bin/env python3
"""Build system/truex-design-spec.html from system/DESIGN-SPEC.md.

DESIGN-SPEC.md is the source of truth; the HTML page is generated from it and
must never be edited by hand. Run after every spec or foundation-CSS change:

    python3 system/tools/build-spec-html.py

The page inlines the six system stylesheets (type, color, space, corner,
primitives, patterns), so every swatch and live specimen renders from the
shipped tokens, in all four contexts, with the system's own theme resolver.
"""
import datetime
import html
import re
import sys
from pathlib import Path

SYS = Path(__file__).resolve().parent.parent
MD = SYS / "DESIGN-SPEC.md"
OUT = SYS / "truex-design-spec.html"
CSS_FILES = ["type.css", "color.css", "space.css", "corner.css", "primitives.css", "patterns.css"]

# Rail groups: chapter number -> part label (first chapter of each part opens it).
PARTS = {0: "Rules & setup", 3: "Foundations", 9: "Components", 11: "Screens",
         16: "Cross-cutting", 19: "Upkeep"}

# Study pages and screens each chapter is written from (relative to system/).
LIVE = {
    3: [("Typography study", "index.html")],
    4: [("Colour & themes study", "02-color.html"), ("Chart studies", "chart-studies.html")],
    5: [("Space & form study", "03-space.html")],
    6: [("Corners study", "04-corners.html")],
    7: [("Icon foundations rev 02", "icon-foundations.html"), ("Icon study", "icon-study.html")],
    8: [("Primitives study", "05-primitives.html")],
    9: [("Primitives study", "05-primitives.html")],
    10: [("Patterns study", "06-patterns.html")],
    11: [("Chat screen", "screens/chat.html")],
    12: [("Chat screen", "screens/chat.html")],
    13: [("Chat screen", "screens/chat.html")],
    14: [("Activity Panel", "screens/business-activity.html")],
    15: [("Agent team board", "screens/agents.html"), ("Agent ID desk", "screens/agent-id.html")],
    16: [("Chart studies", "chart-studies.html")],
}
# Chapters that get a lazy live preview of the real screen.
PREVIEW = {11: "screens/chat.html", 14: "screens/business-activity.html",
           15: "screens/agents.html"}

esc = lambda s: html.escape(s, quote=False)
attr = lambda s: html.escape(s, quote=True)


# ── sources ───────────────────────────────────────────────────────────────────
def read(name):
    return (SYS / name).read_text(encoding="utf-8")


md_lines = read("DESIGN-SPEC.md").splitlines()
css = {f: read(f) for f in CSS_FILES}
COLOR_TOKENS = set(re.findall(r"(--[a-z0-9-]+)\s*:", css["color.css"])) - {"--focus"}


def sprite():
    """Hidden sprite: the shipped chat sprite plus the rev-02 n-* drawings."""
    chat = read("screens/chat.html")
    m = re.search(r'<svg class="sprite"[^>]*>(.*?)</svg>', chat, re.S)
    rev02 = re.findall(r'<symbol id="n-[^"]+".*?</symbol>', read("icon-foundations.html"), re.S)
    ids = re.findall(r'<symbol id="(i-[^"]+)"', m.group(1))
    body = m.group(1) + "\n" + "\n".join(rev02)
    return (f'<svg class="ds-sprite" aria-hidden="true" focusable="false">{body}</svg>',
            ids, [re.search(r'id="([^"]+)"', s).group(1) for s in rev02])


SPRITE, CHAT_ICON_IDS, REV02_IDS = sprite()


# ── headings, slugs, cross-references ─────────────────────────────────────────
def plain(s):
    """Heading markdown -> plain text (for slugs and the rail)."""
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    return s.replace("`", "").replace("**", "").replace("*", "")


def slugify(text, seen):
    s = re.sub(r"[^\w\- ]", "", plain(text).lower()).replace(" ", "-")
    base, n = s, 1
    while s in seen:
        s = f"{base}-{n}"
        n += 1
    seen.add(s)
    return s


HEADINGS = []  # (line index, level, raw text, slug, number or None)
_seen = set()
_in_code = False
for idx, line in enumerate(md_lines):
    if line.startswith("```"):
        _in_code = not _in_code
    if _in_code:
        continue
    m = re.match(r"^(#{1,4}) (.*)$", line)
    if m and len(m.group(1)) > 1:
        text = m.group(2)
        num = re.match(r"^(\d{1,2}(?:\.\d{1,2})?)\.? ", text)
        HEADINGS.append((idx, len(m.group(1)), text, slugify(text, _seen), num.group(1) if num else None))
SLUG_AT = {h[0]: h[3] for h in HEADINGS}
NUM_SLUG = {h[4]: h[3] for h in HEADINGS if h[4]}

NUM = r"\d{1,2}(?:\.\d{1,2})?"


# ── inline markdown ───────────────────────────────────────────────────────────
def code_span(c):
    e = esc(c)
    tok = re.fullmatch(r"(?:var\()?(--[a-z0-9-]+)\)?", c)
    if tok and tok.group(1) in COLOR_TOKENS:
        return f'<code class="tok"><i class="sw" style="--c:var({tok.group(1)})"></i>{e}</code>'
    if re.fullmatch(r"#[0-9A-Fa-f]{3,8}|rgba?\([^)]*\)", c):
        return f'<code class="tok"><i class="sw" style="--c:{attr(c)}"></i>{e}</code>'
    if re.fullmatch(r"[\w./-]+\.(?:css|html|js|tsx|md|py)(?::\d[\d,–-]*)?", c):
        return f'<code class="src">{e}</code>'
    return f"<code>{e}</code>"


def inline(s):
    stash = []

    def keep(h):
        stash.append(h)
        return "\x00" + "".join(chr(97 + int(d)) for d in str(len(stash) - 1)) + "\x00"

    def xref(num, label=None):
        slug = NUM_SLUG.get(num)
        return f'<a class="xref" href="#{slug}">{label or num}</a>' if slug else (label or num)

    s = re.sub(r"`([^`]+)`", lambda m: keep(code_span(m.group(1))), s)
    s = esc(s)
    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)",
               lambda m: keep(f'<a href="{attr(m.group(2))}">{m.group(1)}</a>'), s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])", r"<em>\1</em>", s)

    # "section 7.3", "sections 12.3 and 12.4", "chapter 19", "§19.2" (not "chapter 05": study files)
    def sections(m):
        nums = re.sub(rf"(?<![\d.]){NUM}(?![\d])", lambda n: xref(n.group(0)), m.group(3))
        return keep(m.group(1) + m.group(2) + nums)
    s = re.sub(rf"\b([Ss]ections?|[Cc]hapters?(?= [1-9])|§)(\s?)({NUM}(?:(?:,\s|\sand\s|\sor\s|–){NUM})*)(?![\d\w])", sections, s)

    # "(12.4)", "(19.2 D16, 19.5)", "(see 13.6)" — only when the group opens on a known section
    def parens(m):
        lead = re.match(r"\s*(?:see\s+|migration\s+)?(\d{1,2}\.\d{1,2})(?=$|[\s,;–)])", m.group(1))
        if not lead or lead.group(1) not in NUM_SLUG:
            return m.group(0)
        inner = re.sub(r"(?<![\w.])(\d{1,2}\.\d{1,2})(?![\w.]|\d)", lambda n: xref(n.group(1)), m.group(1))
        return keep("(" + inner + ")")
    s = re.sub(r"\(([^()]*)\)", parens, s)

    while "\x00" in s:
        s = re.sub(r"\x00([a-j]+)\x00",
                   lambda m: stash[int("".join(str(ord(c) - 97) for c in m.group(1)))], s)
    return s


# ── specimens (rendered from the live CSS) ────────────────────────────────────
def spx(title, body, note="rendered from the system CSS"):
    return (f'<figure class="ds-spx"><figcaption><span class="t-micro">Live specimen</span>'
            f'<span>{title} · {note}</span></figcaption><div class="ds-spx-b">{body}</div></figure>')


def ic(i, cls="tx-ic"):
    return f'<svg class="{cls}" aria-hidden="true"><use href="#{i}"/></svg>'


TYPE_ROWS = [
    ("t-hero", "52–108", "Close <em>September.</em>"),
    ("t-display", "56", "Approve the close."),
    ("t-h2", "36–60", "Two accruals left."),
    ("t-h3", "24", "September closes with two exceptions."),
    ("t-h4", "17", "Drive search failed"),
    ("t-lede", "17", "Post two accruals, reconcile 412 ledger lines and write the audit trail."),
    ("t-body", "15", "Recognition landed 3.1% under plan on a softer EMEA close. Two accruals still need a decision before the books lock."),
    ("t-ui", "14", "Approve &amp; run"),
    ("t-meta", "13", "You · 14:02 · 2 files attached"),
    ("t-micro", "11", "Run 04 · T4 · 0 errors"),
    ("t-editorial", "36", "with two exceptions"),
    ("t-num", "36", "61.4k"),
    ("t-code", "0.86em", "jira.create_issue({ project: \"FIN\" })"),
]


def type_spx():
    rows = "".join(f'<div class="ds-type-row"><span class="ds-type-k"><code>.{c}</code><small>{px}</small></span>'
                   f'<div class="{c} ds-type-s">{t}</div></div>' for c, px, t in TYPE_ROWS)
    return spx("The thirteen roles", f'<div class="ds-type">{rows}</div>', "rendered with type.css")


def ctx_spx():
    def col(ctx, label):
        ids = "".join(f'<i style="background:var(--id-{n})" title="--id-{n}"></i>' for n in ["main", 1, 2, 3, 4, 5])
        return f'''<div class="ds-ctx" data-ctx="{ctx}"><span class="t-micro">{label}</span>
<div class="ds-ctx-card"><b class="t-ui">Approve the September close.</b>
<span class="t-meta ds-ink2">Two accruals still need a decision.</span>
<span class="tx-row"><button class="tx-btn tx-primary tx-sm" type="button">Approve</button><button class="tx-btn tx-sm" type="button">Review</button></span>
<span class="tx-row ds-wrap"><span class="tx-pill tx-pill-ok"><span aria-hidden="true">✓</span>Ready</span><span class="tx-pill tx-pill-warn"><span aria-hidden="true">!</span>Needs auth</span><span class="tx-pill tx-pill-bad"><span aria-hidden="true">×</span>Failed</span><span class="tx-pill tx-pill-live"><span class="tx-pulse" aria-hidden="true"></span>Running</span></span>
<span class="ds-ids" aria-label="Identity hues main, 1 to 5">{ids}</span>
<span class="ds-wells"><i style="background:var(--page)"></i><i style="background:var(--surface-2)"></i><i style="background:var(--well)"></i><i style="background:var(--well-2)"></i><i style="background:var(--line-strong)"></i><i style="background:var(--inv)"></i></span>
</div></div>'''
    body = "".join(col(c, l) for c, l in [("light", "Light"), ("dark", "Dark"), ("light+", "Light +"), ("dark+", "Dark +")])
    return spx("Four contexts side by side", f'<div class="ds-ctxs">{body}</div>', "each column pinned with data-ctx")


def lattice_spx():
    rows = "".join(f'<div class="ds-lat"><code>--sp-{k}</code><i style="width:var(--sp-{k})"></i><span class="num">{px}</span></div>'
                   for k, px in [("h", 2), (1, 4), (2, 8), (3, 12), (4, 16), (5, 24), (6, 32), (7, 48), (8, 64), (9, 96)])
    return spx("The lattice", rows, "rendered with space.css")


def elevation_spx():
    tiles = [("T0", "--line only", "box-shadow:none"), ("T1", "--sh-1", "box-shadow:var(--sh-1)"),
             ("T2", "--sh-2", "box-shadow:var(--sh-2)"), ("T3", "--sh-3", "box-shadow:var(--sh-3)"),
             ("Press", "--key", "box-shadow:var(--key)"), ("Focus", "--focus", "box-shadow:var(--focus);border-color:var(--signal)")]
    body = "".join(f'<div class="ds-elev" style="{s}"><b class="t-ui">{t}</b><code>{k}</code></div>' for t, k, s in tiles)
    return spx("Elevation tiers", f'<div class="ds-elevs">{body}</div>', "theme-aware, from space.css")


def radius_spx():
    rs = [("--r-mark", 3), ("--r-xs", 6), ("--r-sm", 10), ("--r", 14), ("--r-lg", 22), ("--r-xl", 30), ("--r-pill", 999)]
    body = "".join(f'<div class="ds-rad"><i style="border-radius:var({t})"></i><code>{t}</code><span class="num">{p}</span></div>' for t, p in rs)
    return spx("Radius ladder", f'<div class="ds-rads">{body}</div>', "squircle where the browser supports corner-shape")


def icon_spx():
    cur = "".join(f'<span class="ds-ic">{ic(i, "tx-ic tx-ic-lg")}<code>{i[2:]}</code></span>' for i in CHAT_ICON_IDS)
    new = "".join(f'<span class="ds-ic">{ic(i, "tx-ic tx-ic-lg")}<code>{i}</code></span>' for i in REV02_IDS)
    return spx("Icon sprites", f'<p class="t-micro ds-ink3">Shipped chat sprite · {len(CHAT_ICON_IDS)} ids</p><div class="ds-ics">{cur}</div>'
               f'<p class="t-micro ds-ink3">Rev 02 continuous hand · {len(REV02_IDS)} drawn</p><div class="ds-ics">{new}</div>',
               "symbols copied from chat.html and icon-foundations.html at build time")


def row(*items):
    return '<div class="tx-row ds-wrap">' + "".join(items) + "</div>"


SPECIMENS = {
    "3.3": type_spx(),
    "4.1": ctx_spx(),
    "5.1": lattice_spx(),
    "5.7": elevation_spx(),
    "6.1": radius_spx(),
    "7.3": icon_spx(),
    "9.4": spx("Buttons", row(
        '<button class="tx-btn tx-primary" type="button">Approve</button>',
        '<button class="tx-btn" type="button">Review</button>',
        '<button class="tx-btn tx-dark" type="button">Open console</button>',
        '<button class="tx-btn tx-ghost" type="button">Dismiss</button>',
        '<button class="tx-btn tx-danger" type="button"><span aria-hidden="true">×</span>Stop</button>')
        + row('<button class="tx-btn tx-primary tx-xs" type="button">XS · 24</button>',
              '<button class="tx-btn tx-primary tx-sm" type="button">SM · 28</button>',
              '<button class="tx-btn tx-primary" type="button">Default · 36</button>',
              '<button class="tx-btn tx-primary tx-lg" type="button">LG · 44</button>')
        + row(f'<button class="tx-btn tx-icon" type="button" aria-label="Tool settings">{ic("i-tool")}</button>',
              f'<button class="tx-btn tx-icon tx-ghost" type="button" aria-label="Assign an agent">{ic("i-agent")}</button>',
              f'<button class="tx-btn" type="button">{ic("i-run", "tx-ic tx-ic-sm")}Run<span class="tx-kbd">⌘↵</span></button>',
              '<button class="tx-btn" type="button" disabled>Disabled</button>',
              '<button class="tx-btn tx-primary" type="button" aria-disabled="true">Can\'t approve</button>',
              '<button class="tx-btn" type="button" disabled><span class="tx-spin" aria-hidden="true"></span>Working…</button>')),
    "9.5": spx("Keycaps", row('<span class="tx-keys"><span class="tx-kbd">⌘</span><span class="tx-kbd">⇧</span><span class="tx-kbd">↵</span></span>',
                              '<span class="tx-keys"><span class="tx-kbd">⌘</span><span class="tx-kbd">K</span></span>',
                              '<span class="tx-keys"><span class="tx-kbd">Esc</span></span>')),
    "9.6": spx("Pills", row(
        '<span class="tx-pill tx-pill-ok"><span aria-hidden="true">✓</span>Ready</span>',
        '<span class="tx-pill tx-pill-warn"><span aria-hidden="true">!</span>Needs auth</span>',
        '<span class="tx-pill tx-pill-bad"><span aria-hidden="true">×</span>Failed</span>',
        '<span class="tx-pill tx-pill-live"><span class="tx-pulse" aria-hidden="true"></span>Running</span>',
        f'<span class="tx-pill tx-pill-inv">{ic("i-agent")}Qlik</span>',
        '<span class="tx-pill tx-pill-line">Draft</span>', '<span class="tx-pill tx-pill-sm">v2</span>',
        '<span class="tx-pill">Neutral</span>')),
    "9.7": spx("Chips", row('<button class="tx-chip" type="button" aria-pressed="false">Datasets</button>',
                            '<button class="tx-chip" type="button" aria-pressed="true">Access</button>',
                            '<button class="tx-chip" type="button" aria-pressed="false">Shadowing</button>',
                            '<button class="tx-chip tx-chip-ref" type="button">err_7f3a21<span class="tx-kbd">⌘C</span></button>')),
    "9.8": spx("Tiles", row(
        f'<span class="tx-tile">{ic("i-tool")}</span>', f'<span class="tx-tile tx-tile-signal">{ic("i-run")}</span>',
        '<span class="tx-tile tx-tile-ok"><span aria-hidden="true">✓</span></span>',
        '<span class="tx-tile tx-tile-warn"><span aria-hidden="true">!</span></span>',
        '<span class="tx-tile tx-tile-bad"><span aria-hidden="true">×</span></span>',
        f'<span class="tx-tile tx-tile-inv">{ic("i-agent")}</span>',
        f'<span class="tx-tile tx-tile-sm">{ic("i-search", "tx-ic tx-ic-sm")}</span>',
        f'<span class="tx-tile tx-tile-lg">{ic("i-tool", "tx-ic tx-ic-lg")}</span>')),
    "9.9": spx("Segmented", row(
        '<div class="tx-seg" role="group" aria-label="Scope" data-seg><button type="button" aria-pressed="true">This turn</button><button type="button" aria-pressed="false">Session</button><button type="button" aria-pressed="false">Project</button></div>',
        '<div class="tx-seg tx-seg-sm" role="group" aria-label="Density" data-seg><button type="button" aria-pressed="false">Comfortable</button><button type="button" aria-pressed="true">Compact</button></div>')),
    "9.10": spx("Tabs", '<div class="tx-tabs" role="tablist" aria-label="Activity Panel"><button role="tab" type="button" aria-selected="true">Activity</button><button role="tab" type="button" aria-selected="false" tabindex="-1">Agent</button><button role="tab" type="button" aria-selected="false" tabindex="-1">Files</button><button role="tab" type="button" aria-selected="false" tabindex="-1">Insights</button></div>'),
    "9.11": spx("Fields", '<div class="ds-fields">'
        '<div class="tx-field"><label for="ds-f1">Session name <span class="tx-req" aria-hidden="true">*</span></label><input class="tx-input" id="ds-f1" value="Onboarding plan for new analysts"><span class="tx-hint">Shown in the session list and the topbar crumb.</span></div>'
        '<div class="tx-field"><label for="ds-f2">Token budget</label><input class="tx-input tx-input-num" id="ds-f2" type="number" value="500000"><span class="tx-hint">142.2k used · 28%.</span></div>'
        '<div class="tx-field"><label for="ds-f3">Approval mode</label><select class="tx-input tx-select" id="ds-f3"><option>Ask every time</option><option selected>Auto-approve reads</option></select></div>'
        '<div class="tx-field"><label for="ds-f4">Drive token</label><div class="tx-secret"><input class="tx-input" id="ds-f4" type="password" value="example-redacted" autocomplete="off"><button class="tx-reveal" type="button" aria-pressed="false" aria-controls="ds-f4" aria-label="Show token">Show</button></div><span class="tx-hint">Stored in the OS keychain, never the session.</span></div>'
        '<div class="tx-field"><label for="ds-f5">Jira project key</label><input class="tx-input" id="ds-f5" value="onboarding plan" aria-invalid="true" aria-describedby="ds-f5m"><span class="tx-hint tx-errmsg" id="ds-f5m"><span aria-hidden="true">!</span>Keys are 2–6 uppercase letters, e.g. <code>ONB</code>.</span></div>'
        '</div>'),
    "9.12": spx("Switch", row('<label class="ds-sw"><input type="checkbox" role="switch" class="tx-switch" checked><span>Auto-approve reads</span></label>',
                              '<label class="ds-sw"><input type="checkbox" role="switch" class="tx-switch"><span>Pause on error</span></label>')),
    "9.13": spx("Menu", '<nav class="tx-menu ds-menu" aria-label="Turn actions"><div class="tx-menu-h">Turn</div>'
        '<button class="tx-menu-item" type="button"><span>Steer the agent<small>Interrupt without losing the plan</small></span><span class="tx-kbd">S</span></button>'
        '<button class="tx-menu-item" type="button"><span>Retry turn<small>Re-run from the last prompt</small></span><span class="tx-kbd">R</span></button>'
        '<div class="tx-menu-sep" role="separator"></div>'
        '<button class="tx-menu-item tx-menu-danger" type="button"><span>Stop session</span><span class="tx-kbd">Del</span></button></nav>'),
    "9.14": spx("Tooltip", row('<span class="tx-tip"><button class="tx-btn" type="button" aria-describedby="ds-tt1">Last run · hover or focus</button><span class="tx-tip-pop" role="tooltip" id="ds-tt1">2m 04s · 48.0k tokens</span></span>')),
    "9.15": spx("Toast", '<div class="tx-toast ds-toast" aria-hidden="true"><span class="tx-tile tx-tile-ok"><span aria-hidden="true">✓</span></span><div><h5>Checklist saved</h5><p>18 of 30 rows saved.</p></div><span class="tx-toast-x" aria-hidden="true">×</span></div>', "static sample; real toasts mount in .tx-toast-host"),
    "9.16": spx("Meter, bar, ring", '<div class="ds-meters">'
        + "".join(f'<div class="tx-meter tx-meter-{k}" style="--tx-p:{p}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="{p}" aria-label="{k}"><i></i></div>'
                  for k, p in [("signal", 24), ("ok", 62), ("warn", 81), ("bad", 96)])
        + '</div>' + row('<span class="tx-ring" style="--tx-p:24"><span class="num">24%</span></span>',
                         '<span class="tx-ring" style="--tx-p:72;--tx-sz:2.5rem"><span class="num">72</span></span>',
                         '<div class="tx-bar ds-bar"><i style="width:60%"></i></div>')),
    "9.17": spx("Live cues", row('<span class="tx-pill tx-pill-live"><span class="tx-spin" aria-hidden="true"></span>Working</span>',
                                 '<span class="tx-shimmer">Thinking…</span>',
                                 '<span>Writing checklist<span class="tx-caret"></span></span>',
                                 '<div class="tx-bar ds-bar"><i class="tx-stripes" style="width:60%"></i></div>')
        + row('<span class="ds-skels"><span class="tx-skel" style="height:.75rem;width:70%"></span><span class="tx-skel" style="height:.75rem;width:90%"></span></span>',
              '<span class="tx-tape">needs auth</span>', '<span class="tx-dot tx-dot-live"></span>', '<span class="tx-dot tx-dot-ok"></span>',
              '<span class="tx-dot tx-dot-warn"></span>', '<span class="tx-dot tx-dot-bad"></span>', '<span class="tx-dot tx-dot-off"></span>'),
        "static twins replace motion under reduced motion"),
    "9.18": spx("Card states", '<div class="ds-states">'
        f'<div class="tx-card tx-card-pad tx-state"><span class="tx-tile tx-tile-lg">{ic("i-search", "tx-ic tx-ic-lg")}</span><h4>No sessions yet</h4><p>Start a session to see turns, plans and files here.</p><button class="tx-btn tx-primary tx-sm" type="button">New session</button></div>'
        '<div class="tx-card tx-card-pad tx-state" aria-busy="true"><span class="tx-tile tx-tile-lg tx-tile-signal"><span class="tx-spin" aria-hidden="true"></span></span><h4><span class="tx-shimmer">Loading activity…</span></h4><span class="ds-skels"><span class="tx-skel" style="height:.75rem;width:80%"></span><span class="tx-skel" style="height:.75rem;width:60%"></span></span></div>'
        '<div class="tx-card tx-card-pad tx-state tx-state-error"><span class="tx-tile tx-tile-lg tx-tile-bad"><span aria-hidden="true">×</span></span><h4>Drive search failed</h4><p>Token expired. <span class="tx-chip tx-chip-ref">err_7f3a21</span></p><span class="tx-row"><button class="tx-btn tx-sm" type="button">Reconnect</button><button class="tx-btn tx-ghost tx-sm" type="button">Retry</button></span></div>'
        '</div>'),
}


# ── block markdown ────────────────────────────────────────────────────────────
def split_row(line):
    cells = re.split(r"(?<!\\)\|", line.strip()[1:-1] if line.strip().endswith("|") else line.strip()[1:])
    return [c.strip().replace("\\|", "|") for c in cells]


COLOR_LIT = re.compile(r"^`(#[0-9A-Fa-f]{3,8}|rgba?\([^)]*\))`$")


def table(rows):
    head, aligns, body = split_row(rows[0]), split_row(rows[1]), [split_row(r) for r in rows[2:]]
    al = ["right" if a.endswith(":") and not a.startswith(":") else "center" if a.startswith(":") and a.endswith(":") else "" for a in aligns]
    st = lambda i: f' style="text-align:{al[i]}"' if i < len(al) and al[i] else ""
    out = ['<div class="ds-tbl"><table class="ds-spec"><thead><tr>']
    out += [f"<th{st(i)}>{inline(h)}</th>" for i, h in enumerate(head)]
    out.append("</tr></thead><tbody>")
    for r in body:
        out.append("<tr>")
        last = None
        for i, c in enumerate(r):
            lit = COLOR_LIT.match(c)
            if lit:
                last = lit.group(1)
            if c == "=" and last:  # "same as the column to its left": show the inherited colour
                cell = f'<span class="ds-eq"><i class="sw" style="--c:{attr(last)}"></i>=</span>'
            else:
                cell = inline(c)
            out.append(f"<td{st(i)}>{cell}</td>")
        out.append("</tr>")
    out.append("</tbody></table></div>")
    return "".join(out)


def list_block(items, chk_prefix):
    out, stack = [], []
    for ind, ordered, num, text in items:
        while stack and ind < stack[-1][0]:
            out.append(f"</li></{stack.pop()[1]}>")
        if stack and ind == stack[-1][0]:
            out.append("</li>")
        else:
            tag = "ol" if ordered else "ul"
            start = f' start="{num}"' if ordered and num != 1 else ""
            box = ' class="ds-chk"' if text.startswith("[ ] ") else ""
            out.append(f"<{tag}{start}{box}>")
            stack.append((ind, tag))
        if text.startswith("[ ] "):
            k = f"{chk_prefix}-{len(out)}"
            out.append(f'<li><label><input type="checkbox" data-k="{k}"><span>{inline(text[4:])}</span></label>')
        else:
            out.append("<li>" + inline(text))
    while stack:
        out.append(f"</li></{stack.pop()[1]}>")
    return "".join(out)


def code_block(lang, lines):
    label = {"js": "JavaScript", "html": "HTML", "css": "CSS"}.get(lang, lang or "Text")
    return (f'<div class="ds-code"><div class="ds-code-h"><span class="t-micro">{label}</span>'
            f'<button class="tx-btn tx-ghost tx-xs ds-copy" type="button">Copy</button></div>'
            f'<pre><code>{esc(chr(10).join(lines))}</code></pre></div>')


def render():
    hero, sections, rail = [], [], []
    cur = None          # current chapter dict
    pending = None      # specimen waiting for the end of its subsection
    para = []
    i, n = 0, len(md_lines)
    title = ""
    skip_contents = False

    def flush_para():
        if not para:
            return
        text = " ".join(para)
        para.clear()
        target = cur["body"] if cur else hero
        if cur is None and text.startswith("Version "):
            hero.append(("meta", text))
        elif text.startswith("Status:"):
            target.append(f'<p class="ds-note">{inline(text)}</p>')
        elif re.fullmatch(r"\*\*[^*]+\*\*", text):
            target.append(f'<p class="ds-group">{inline(text)}</p>')
        else:
            target.append(f"<p>{inline(text)}</p>" if cur else ("p", text))

    def flush_spx():
        nonlocal pending
        if pending and cur:
            cur["body"].append(pending)
        pending = None

    while i < n:
        line = md_lines[i]
        if line.startswith("```"):
            flush_para()
            lang, j = line[3:].strip(), i + 1
            while not md_lines[j].startswith("```"):
                j += 1
            (cur["body"] if cur else hero).append(code_block(lang, md_lines[i + 1:j]))
            i = j + 1
            continue
        m = re.match(r"^(#{1,4}) (.*)$", line)
        if m:
            flush_para()
            level, text = len(m.group(1)), m.group(2)
            if level == 1:
                title = text
            elif level == 2:
                flush_spx()
                skip_contents = text == "Contents"
                if not skip_contents:
                    num = int(re.match(r"(\d+)", text).group(1))
                    cur = {"num": num, "title": re.sub(r"^\d+\.\s*", "", text), "slug": SLUG_AT[i], "body": [], "subs": []}
                    sections.append(cur)
            elif not skip_contents:
                slug = SLUG_AT[i]
                if level == 3:
                    flush_spx()
                    hn = re.match(rf"^({NUM}) (.*)$", text)
                    if hn:
                        cur["body"].append(f'<h3 id="{slug}"><a class="ds-hn" href="#{slug}">{hn.group(1)}</a> {inline(hn.group(2))}</h3>')
                        pending = SPECIMENS.get(hn.group(1))
                    else:
                        cur["body"].append(f'<h3 id="{slug}">{inline(text)}</h3>')
                    cur["subs"].append((slug, plain(text)))
                else:
                    cur["body"].append(f'<h4 id="{slug}">{inline(text)}</h4>')
            i += 1
            continue
        if skip_contents:
            i += 1
            continue
        if line.strip() == "---":
            flush_para()
            i += 1
            continue
        if line.startswith("|"):
            flush_para()
            j = i
            while j < n and md_lines[j].startswith("|"):
                j += 1
            cur["body"].append(table(md_lines[i:j]))
            i = j
            continue
        lm = re.match(r"^( *)([-*]|\d+\.) (.*)$", line)
        if lm:
            flush_para()
            items, j = [], i
            while j < n and (im := re.match(r"^( *)([-*]|\d+\.) (.*)$", md_lines[j])):
                o = im.group(2)[0].isdigit()
                items.append((len(im.group(1)), o, int(im.group(2)[:-1]) if o else 0, im.group(3)))
                j += 1
            cur["body"].append(list_block(items, f"c{cur['num']}-{i}"))
            i = j
            continue
        if line.startswith("> "):
            flush_para()
            j, q = i, []
            while j < n and md_lines[j].startswith(">"):
                q.append(md_lines[j][1:].strip())
                j += 1
            cur["body"].append(f'<p class="ds-note">{inline(" ".join(q))}</p>')
            i = j
            continue
        if not line.strip():
            flush_para()
        else:
            para.append(line.strip())
        i += 1
    flush_para()
    flush_spx()
    return title, hero, sections


# ── page ──────────────────────────────────────────────────────────────────────
PAGE_CSS = r"""
/* Spec page chrome. Built only from system tokens, so the page obeys the spec it states. */
.ds-sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
body { margin: 0; background: var(--surface); color: var(--ink); }
.ds-page { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); gap: var(--sp-7); max-width: var(--wrap); margin: 0 auto; padding: var(--sp-6) var(--gutter) var(--sp-9); }
.ds-rail { position: sticky; top: var(--sp-4); align-self: start; max-height: calc(100vh - var(--sp-6)); overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding-right: var(--sp-2); overscroll-behavior: contain; }
.ds-rail .pt-brand { text-decoration: none; color: var(--ink); }
.ds-find { width: 100%; }
.ds-toc, .ds-toc ol { list-style: none; margin: 0; padding: 0; }
.ds-toc { display: flex; flex-direction: column; gap: var(--sp-h); }
.ds-part { margin-top: var(--sp-3); padding: 0 var(--sp-2) var(--sp-1); color: var(--ink-3); }
.ds-toc a { display: grid; grid-template-columns: 1.75rem 1fr; gap: var(--sp-1); padding: var(--sp-1) var(--sp-2); border-radius: var(--r-sm); color: var(--ink-2); text-decoration: none; font-size: var(--t-meta); line-height: var(--lh-meta); }
.ds-toc a:hover { background: var(--well); color: var(--ink); }
.ds-toc a .num { color: var(--ink-3); }
.ds-toc li.is-on > a { background: var(--signal-soft); color: var(--signal-ink); font-weight: 600; }
.ds-toc ol { display: none; margin: var(--sp-h) 0 var(--sp-1); }
.ds-toc li.is-on > ol, .ds-rail.is-finding .ds-toc ol, html:not(.js) .ds-toc ol { display: flex; flex-direction: column; }
.ds-toc ol a { grid-template-columns: 2.25rem 1fr; padding-block: var(--sp-h); color: var(--ink-3); }
.ds-toc ol a.is-cur { color: var(--ink); }
.ds-toc [hidden] { display: none !important; }
.ds-prefs { display: grid; gap: var(--sp-2); padding-top: var(--sp-3); border-top: 1px solid var(--line); }
.ds-prefs > div { display: grid; gap: var(--sp-1); }
.ds-prefs .t-micro { color: var(--ink-3); }
main { min-width: 0; }

.ds-hero { display: grid; gap: var(--sp-4); padding-bottom: var(--sp-7); border-bottom: 1px solid var(--line); }
.ds-hero .t-display { max-width: 18ch; }
.ds-hero p { max-width: var(--measure-lede); color: var(--ink-2); }
.ds-meta { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.ds-rules { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: var(--sp-3); }
.ds-rules div { padding: var(--sp-3) var(--sp-4); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); }
.ds-rules b { display: block; }
.ds-rules span { color: var(--ink-2); font-size: var(--t-meta); }

.ds-sec { padding-top: var(--sp-8); scroll-margin-top: var(--sp-4); }
.ds-sec + .ds-sec { margin-top: var(--sp-6); border-top: 1px solid var(--line); }
.ds-ch { display: grid; gap: var(--sp-3); margin-bottom: var(--sp-5); }
.ds-ch .t-micro { color: var(--signal-ink); }
.ds-live { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.ds-live a { text-decoration: none; }
.ds-sec h3 { margin: var(--sp-7) 0 var(--sp-3); scroll-margin-top: var(--sp-4); }
.ds-sec h4 { margin: var(--sp-5) 0 var(--sp-2); scroll-margin-top: var(--sp-4); }
.ds-hn { margin-right: var(--sp-2); color: var(--ink-3); text-decoration: none; font-family: var(--f-mono); font-size: 0.7em; font-weight: 500; letter-spacing: 0; vertical-align: 0.12em; }
.ds-hn:hover { color: var(--signal-ink); }
.ds-sec p, .ds-sec li { max-width: var(--measure-body); color: var(--ink-2); }
.ds-sec p strong, .ds-sec li strong, .ds-sec td strong { color: var(--ink); font-weight: 650; }
.ds-sec ul, .ds-sec ol { margin: 0 0 var(--sp-4); padding-left: var(--sp-5); display: grid; gap: var(--sp-1); }
.ds-sec li > ul, .ds-sec li > ol { margin: var(--sp-1) 0 0; }
.ds-group { margin: var(--sp-5) 0 var(--sp-2); }
.ds-note { padding: var(--sp-3) var(--sp-4); border-radius: var(--r); background: var(--signal-soft); color: var(--ink) !important; max-width: none !important; }
.ds-sec a, .ds-hero a { color: var(--signal-ink); text-underline-offset: 0.18em; }
a.xref { text-decoration-style: dotted; }

code { padding: 0.08em 0.36em; border-radius: var(--r-xs); background: var(--well); color: var(--ink); overflow-wrap: anywhere; }
code.src { color: var(--ink-2); background: none; padding: 0; }
code.tok { white-space: nowrap; }
.sw { display: inline-block; width: 0.8125rem; height: 0.8125rem; margin-right: var(--sp-1); vertical-align: -0.12em; border-radius: var(--r-mark); background: var(--c); box-shadow: inset 0 0 0 1px var(--line-strong); }
.ds-eq { color: var(--ink-3); white-space: nowrap; }
.ds-eq .sw { opacity: 0.55; }

.ds-tbl { margin: var(--sp-3) 0 var(--sp-4); border: 1px solid var(--line); border-radius: var(--r); overflow-x: auto; background: var(--surface); }
table.ds-spec { width: 100%; border-collapse: collapse; font-size: var(--t-meta); line-height: var(--lh-meta); font-variant-numeric: tabular-nums; }
table.ds-spec th { text-align: left; font-family: var(--f-mono); font-size: var(--t-micro); font-weight: 600; letter-spacing: var(--tr-micro); text-transform: uppercase; color: var(--ink-3); background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; border-bottom: 1px solid var(--line); }
table.ds-spec td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--line); vertical-align: top; color: var(--ink-2); }
table.ds-spec tr:first-child td { border-top: 0; }
table.ds-spec td:first-child { color: var(--ink); }
table.ds-spec td:first-child code { white-space: nowrap; font-weight: 500; }
table.ds-spec tbody tr:hover td { background: var(--surface-2); }

.ds-code { margin: var(--sp-3) 0 var(--sp-4); border: 1px solid var(--line); border-radius: var(--r); background: var(--well); overflow: hidden; }
.ds-code-h { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-3); border-bottom: 1px solid var(--line); color: var(--ink-3); }
.ds-code pre { margin: 0; padding: var(--sp-3) var(--sp-4); overflow-x: auto; }
.ds-code pre code { padding: 0; background: none; white-space: pre; overflow-wrap: normal; line-height: var(--lh-code); }
.ds-code.is-long pre { max-height: 32rem; }

.ds-spx { margin: var(--sp-4) 0 var(--sp-5); border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface-2); overflow: hidden; }
.ds-spx figcaption { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); padding: var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--line); color: var(--ink-3); font-size: var(--t-meta); }
.ds-spx figcaption .t-micro { color: var(--signal-ink); }
.ds-spx-b { display: grid; gap: var(--sp-4); padding: var(--sp-5) var(--sp-4); overflow-x: auto; }
.ds-wrap { flex-wrap: wrap; }
.ds-ink2 { color: var(--ink-2); }
.ds-ink3 { color: var(--ink-3); margin: 0; }

.ds-type { display: grid; }
.ds-type-row { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: var(--sp-4); align-items: baseline; padding: var(--sp-3) 0; border-top: 1px solid var(--line); }
.ds-type-row:first-child { border-top: 0; padding-top: 0; }
.ds-type-k { display: grid; gap: var(--sp-h); }
.ds-type-k small { color: var(--ink-3); font-family: var(--f-mono); font-size: var(--t-micro); }
.ds-type-s { min-width: 0; overflow-wrap: anywhere; }

.ds-ctxs { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--sp-3); }
.ds-ctx { display: grid; gap: var(--sp-2); padding: var(--sp-3); border-radius: var(--r); background: var(--page); color: var(--ink); }
.ds-ctx .t-micro { color: var(--ink-3); }
.ds-ctx-card { display: grid; gap: var(--sp-2); padding: var(--sp-4); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); box-shadow: var(--sh-1); }
.ds-ids, .ds-wells { display: flex; gap: var(--sp-1); }
.ds-ids i { width: 1rem; height: 1rem; border-radius: 50%; }
.ds-wells i { flex: 1; height: 1rem; border-radius: var(--r-mark); box-shadow: inset 0 0 0 1px var(--line); }

.ds-lat { display: grid; grid-template-columns: 5rem minmax(0, 1fr) 2.5rem; gap: var(--sp-3); align-items: center; }
.ds-lat i { display: block; height: var(--sp-3); border-radius: var(--r-mark); background: var(--signal-soft-2); }
.ds-lat .num { color: var(--ink-3); font-size: var(--t-meta); text-align: right; }

.ds-elevs { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: var(--sp-4); padding: var(--sp-2); }
.ds-elev { display: grid; gap: var(--sp-1); padding: var(--sp-4); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); }

.ds-rads { display: flex; flex-wrap: wrap; gap: var(--sp-5); align-items: end; }
.ds-rad { display: grid; gap: var(--sp-1); justify-items: start; }
.ds-rad i { width: 5rem; height: 4rem; border: 1.5px solid var(--signal); background: var(--signal-soft); }
.ds-rad .num { color: var(--ink-3); font-size: var(--t-meta); }

.ds-ics { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: var(--sp-2); }
.ds-ic { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2); border-radius: var(--r-sm); background: var(--surface); border: 1px solid var(--line); color: var(--ink-2); min-width: 0; }
.ds-ic code { background: none; padding: 0; font-size: var(--t-micro); color: var(--ink-3); overflow-wrap: anywhere; }

.ds-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: var(--sp-4); }
.ds-sw { display: inline-flex; align-items: center; gap: var(--sp-2); }
.ds-menu { max-width: 20rem; }
.ds-toast { max-width: 22rem; }
.ds-meters { display: grid; gap: var(--sp-3); max-width: 24rem; }
.ds-bar { width: 12rem; }
.ds-skels { display: grid; gap: var(--sp-1); width: 12rem; }
.ds-states { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--sp-4); }

.ds-chk { list-style: none; padding-left: 0 !important; }
.ds-chk label { display: flex; gap: var(--sp-2); align-items: baseline; cursor: pointer; }
.ds-chk input { accent-color: var(--signal); flex: none; transform: translateY(0.12em); }
.ds-chk input:checked + span { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--line-strong); }
.ds-chk-bar { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: var(--sp-3) 0; }

.ds-preview { margin: var(--sp-4) 0; border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; background: var(--surface-2); }
.ds-preview summary { padding: var(--sp-3) var(--sp-4); cursor: pointer; font-weight: 600; }
.ds-preview iframe { display: block; width: 100%; height: 46rem; border: 0; border-top: 1px solid var(--line); background: var(--page); }
.ds-appx details { margin: var(--sp-3) 0; border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
.ds-appx summary { display: flex; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); cursor: pointer; background: var(--surface-2); }
.ds-appx summary .num { color: var(--ink-3); font-size: var(--t-meta); }
.ds-appx .ds-code { margin: 0; border: 0; border-top: 1px solid var(--line); border-radius: 0; }
.ds-foot { margin-top: var(--sp-8); padding-top: var(--sp-4); border-top: 1px solid var(--line); color: var(--ink-3); font-size: var(--t-meta); }

:focus-visible { outline: none; box-shadow: var(--focus); border-radius: var(--r-xs); }
@media (max-width: 60rem) {
  .ds-page { grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); padding-top: var(--sp-4); }
  .ds-rail { position: static; max-height: none; padding-bottom: var(--sp-4); border-bottom: 1px solid var(--line); }
  .ds-toc ol { display: none !important; }
  .ds-type-row { grid-template-columns: minmax(0, 1fr); gap: var(--sp-1); }
}
@media print {
  .ds-rail, .ds-copy, .ds-preview, .ds-chk-bar { display: none !important; }
  .ds-page { display: block; }
  .ds-code pre { max-height: none !important; }
}
"""

RESOLVER = r"""(function () {
  var r = document.documentElement;
  r.classList.add("js");
  window.txResolve = function () {
    var pref = "auto", size = "100", contrast = "system";
    try {
      pref = localStorage.getItem("tx-sys-theme") || "auto";
      size = localStorage.getItem("tx-sys-size") || "100";
      contrast = localStorage.getItem("tx-sys-contrast") || "system";
    } catch (e) {}
    r.dataset.theme = pref;
    r.dataset.contrast = contrast;
    if (size !== "100") r.dataset.textsize = size; else delete r.dataset.textsize;
    var dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    var more = contrast === "more" || (contrast === "system" && matchMedia("(prefers-contrast: more)").matches);
    r.dataset.effTheme = dark ? "dark" : "light";
    r.dataset.effContrast = more ? "more" : "normal";
    r.dataset.effMotion = matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "full";
  };
  window.txResolve();
})();"""

PAGE_JS = r"""
(function () {
  var $ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  // Preferences: same storage keys and resolver as the study pages and the app (spec 2.3).
  var keys = { theme: "tx-sys-theme", contrast: "tx-sys-contrast", size: "tx-sys-size" };
  function syncPrefs() {
    $("[data-pref]").forEach(function (g) {
      var cur; try { cur = localStorage.getItem(keys[g.dataset.pref]); } catch (e) {}
      cur = cur || g.dataset.default;
      $("button", g).forEach(function (b) { b.setAttribute("aria-pressed", String(b.value === cur)); });
    });
  }
  $("[data-pref] button").forEach(function (b) {
    b.addEventListener("click", function () {
      try { localStorage.setItem(keys[b.parentNode.dataset.pref], b.value); } catch (e) {}
      window.txResolve(); syncPrefs();
    });
  });
  ["(prefers-color-scheme: dark)", "(prefers-contrast: more)", "(prefers-reduced-motion: reduce)"].forEach(function (q) {
    var m = matchMedia(q); if (m.addEventListener) m.addEventListener("change", window.txResolve);
  });
  syncPrefs();

  // Specimen segmented controls toggle like the real ones.
  $(".ds-spx [data-seg]").forEach(function (g) {
    $("button", g).forEach(function (b) {
      b.addEventListener("click", function () {
        $("button", g).forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
      });
    });
  });
  $(".ds-spx .tx-chip:not(.tx-chip-ref)").forEach(function (c) {
    c.addEventListener("click", function () { c.setAttribute("aria-pressed", String(c.getAttribute("aria-pressed") !== "true")); });
  });
  $(".ds-spx .tx-reveal").forEach(function (b) {
    b.addEventListener("click", function () {
      var on = b.getAttribute("aria-pressed") !== "true", input = document.getElementById(b.getAttribute("aria-controls"));
      b.setAttribute("aria-pressed", String(on)); input.type = on ? "text" : "password"; b.textContent = on ? "Hide" : "Show";
    });
  });

  // Copy buttons.
  function copy(text, btn) {
    var done = function () { var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done); else done();
  }
  $(".ds-copy").forEach(function (b) {
    b.addEventListener("click", function () { copy(b.closest(".ds-code").querySelector("code").textContent, b); });
  });
  $(".ds-code").forEach(function (c) { if (c.querySelector("code").textContent.split("\n").length > 40) c.classList.add("is-long"); });

  // Review checklist: ticks persist per browser; copy as Markdown for the PR description.
  var CK = "tx-spec-checklist";
  var state = {}; try { state = JSON.parse(localStorage.getItem(CK) || "{}"); } catch (e) {}
  $(".ds-chk input").forEach(function (i) {
    i.checked = !!state[i.dataset.k];
    i.addEventListener("change", function () { state[i.dataset.k] = i.checked; try { localStorage.setItem(CK, JSON.stringify(state)); } catch (e) {} });
  });
  var md = document.getElementById("ds-checklist-md");
  $("[data-chk-copy]").forEach(function (b) { b.addEventListener("click", function () { copy(md.textContent.trim(), b); }); });
  $("[data-chk-reset]").forEach(function (b) {
    b.addEventListener("click", function () { state = {}; try { localStorage.removeItem(CK); } catch (e) {} $(".ds-chk input").forEach(function (i) { i.checked = false; }); });
  });

  // Rail: current chapter and sub-section.
  var links = {}; $(".ds-toc a").forEach(function (a) { links[a.getAttribute("href").slice(1)] = a; });
  var secs = $(".ds-sec"), heads = $(".ds-sec h3[id]");
  function spy() {
    var y = innerHeight * 0.25, on = secs[0], cur = null;
    secs.forEach(function (s) { if (s.getBoundingClientRect().top <= y) on = s; });
    heads.forEach(function (h) { if (on.contains(h) && h.getBoundingClientRect().top <= y) cur = h; });
    $(".ds-toc li.is-on").forEach(function (li) { li.classList.remove("is-on"); });
    $(".ds-toc a.is-cur").forEach(function (a) { a.classList.remove("is-cur"); a.removeAttribute("aria-current"); });
    var a = links[on.id]; if (a) { a.parentNode.classList.add("is-on"); }
    var c = cur && links[cur.id]; if (c) { c.classList.add("is-cur"); c.setAttribute("aria-current", "location"); }
  }
  var raf = 0; addEventListener("scroll", function () { cancelAnimationFrame(raf); raf = requestAnimationFrame(spy); }, { passive: true });
  spy();

  // Rail filter.
  var rail = document.querySelector(".ds-rail"), find = document.getElementById("ds-find");
  find.addEventListener("input", function () {
    var q = find.value.trim().toLowerCase();
    rail.classList.toggle("is-finding", !!q);
    $(".ds-toc > li").forEach(function (li) {
      if (!li.querySelector("a")) { li.hidden = !!q; return; }
      var any = false;
      $("ol li", li).forEach(function (s) { var hit = !q || s.textContent.toLowerCase().indexOf(q) > -1; s.hidden = !hit; any = any || hit; });
      var own = li.querySelector("a").textContent.toLowerCase().indexOf(q) > -1;
      li.hidden = !!q && !any && !own;
    });
  });
  addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement === document.body) { e.preventDefault(); find.focus(); }
  });
})();
"""


def build():
    title, hero, sections = render()
    today = datetime.date.today().isoformat()
    version = next((t for k, t in hero if k == "meta"), "")
    intro = [t for k, t in hero if k == "p"]

    # rail
    toc = []
    for s in sections:
        if s["num"] in PARTS:
            toc.append(f'<li class="ds-part t-micro" aria-hidden="true">{PARTS[s["num"]]}</li>')
        subs = "".join(f'<li><a href="#{sl}"><span class="num">{esc(t.split(" ", 1)[0])}</span><span>{esc(t.split(" ", 1)[1] if " " in t else t)}</span></a></li>'
                       if re.match(NUM, t) else f'<li><a href="#{sl}"><span></span><span>{esc(t)}</span></a></li>'
                       for sl, t in s["subs"])
        toc.append(f'<li><a href="#{s["slug"]}"><span class="num">{s["num"]}</span><span>{esc(plain(s["title"]))}</span></a>'
                   + (f"<ol>{subs}</ol>" if subs else "") + "</li>")
    toc.append('<li class="ds-part t-micro" aria-hidden="true">Appendix</li>')
    toc.append('<li><a href="#appendix"><span class="num">A</span><span>Foundation source</span></a></li>')

    def seg(pref, default, opts, label):
        b = "".join(f'<button type="button" value="{v}" aria-pressed="false">{t}</button>' for v, t in opts)
        return (f'<div><span class="t-micro">{label}</span><div class="tx-seg tx-seg-sm" role="group" '
                f'aria-label="{label}" data-pref="{pref}" data-default="{default}">{b}</div></div>')

    rail = (f'<nav class="ds-rail" aria-label="Contents">'
            f'<a class="pt-brand" href="#top"><span class="pt-brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><ellipse cx="8.6" cy="12" rx="2.2" ry="3" fill="currentColor"/><ellipse cx="15.4" cy="12" rx="2.2" ry="3" fill="currentColor"/></svg></span>'
            f'<span class="pt-brand-text"><span class="pt-brand-word">truex</span><span class="pt-brand-sub">Design spec · v2</span></span></a>'
            f'<input class="tx-input ds-find" id="ds-find" type="search" placeholder="Find a section  /" aria-label="Find a section" autocomplete="off">'
            f'<ol class="ds-toc">{"".join(toc)}</ol>'
            f'<div class="ds-prefs">{seg("theme", "auto", [("auto", "Auto"), ("light", "Light"), ("dark", "Dark")], "Theme")}'
            f'{seg("contrast", "system", [("system", "System"), ("normal", "Normal"), ("more", "More")], "Contrast")}'
            f'{seg("size", "100", [("100", "100%"), ("150", "150%"), ("200", "200%")], "Text size")}</div></nav>')

    # hero
    rule_words = next((p for p in intro if p.startswith("Rule words")), None)
    hero_ps = "".join(f"<p>{inline(p)}</p>" for p in intro if p is not rule_words)
    rules_html = ""
    if rule_words:
        rules_html = ('<div class="ds-rules">'
                      '<div><b class="t-ui">must</b><span>Required. A review blocks without it.</span></div>'
                      '<div><b class="t-ui">must not</b><span>Forbidden.</span></div>'
                      '<div><b class="t-ui">should</b><span>Default. Deviate only with a written reason in the PR.</span></div></div>')
    meta = "".join(f'<span class="tx-pill tx-pill-line">{inline(x.strip())}</span>' for x in version.split("·")[:2])
    meta += f'<span class="tx-pill tx-pill-line">{len(sections)} chapters</span>'
    meta += f'<span class="tx-pill tx-pill-line">Generated {today} from <code>DESIGN-SPEC.md</code></span>'
    applies = version.split("·", 2)[2].strip() if version.count("·") >= 2 else ""
    hero_html = (f'<header class="ds-hero" id="top"><span class="t-micro ds-ink3">{esc(title)}</span>'
                 f'<h1 class="t-display">Application design <em>specification</em></h1>'
                 f'<p class="t-lede">{inline(applies[:1].upper() + applies[1:]) if applies else ""}</p>'
                 f'<div class="ds-meta">{meta}</div>{hero_ps}{rules_html}'
                 f'<p class="ds-note">This page is generated from <a href="DESIGN-SPEC.md"><code>DESIGN-SPEC.md</code></a> by '
                 f'<code>system/tools/build-spec-html.py</code>. Do not edit it by hand: change the Markdown (or the foundation CSS) and rebuild. '
                 f'Every swatch and specimen here renders from the six system stylesheets inlined in this file, so the page always shows the shipped values.</p></header>')

    # chapters
    body = []
    for s in sections:
        live = "".join(f'<a class="tx-pill tx-pill-line" href="{h}">{ic("i-chev", "tx-ic tx-ic-sm")}{esc(t)}</a>' for t, h in LIVE.get(s["num"], []))
        head = (f'<header class="ds-ch"><span class="t-micro">Chapter {s["num"]:02d}</span>'
                f'<h2 class="t-h2">{inline(s["title"])}</h2>'
                + (f'<div class="ds-live">{live}</div>' if live else "") + "</header>")
        extra = ""
        if s["num"] in PREVIEW:
            extra = (f'<details class="ds-preview"><summary>Preview the live screen · <code class="src">{PREVIEW[s["num"]]}</code></summary>'
                     f'<iframe src="{PREVIEW[s["num"]]}" title="Live preview of {PREVIEW[s["num"]]}" loading="lazy"></iframe></details>')
        chk = ""
        if s["num"] == 20:
            lines, on = [], False
            for line in md_lines:
                if line.startswith("## 20."):
                    on = True
                    continue
                if on and (line.startswith("## ") or line.strip() == "---"):
                    break
                if on and (line.startswith("**") or line.startswith("- [ ]")):
                    lines.append(line)
            chk = ('<div class="ds-chk-bar"><button class="tx-btn tx-sm tx-primary" type="button" data-chk-copy>Copy checklist as Markdown</button>'
                   '<button class="tx-btn tx-sm tx-ghost" type="button" data-chk-reset>Clear ticks</button></div>'
                   f'<script type="text/plain" id="ds-checklist-md">{esc(chr(10).join(lines))}</script>')
        body.append(f'<section class="ds-sec" id="{s["slug"]}" aria-labelledby="{s["slug"]}-h">'
                    + head.replace("<h2 ", f'<h2 id="{s["slug"]}-h" ', 1) + extra + chk + "".join(s["body"]) + "</section>")

    # appendix: verbatim foundation source
    appx = "".join(
        f'<details{" open" if f == "color.css" else ""}><summary><b class="t-ui">{f}</b>'
        f'<span class="num">{css[f].count(chr(10)) + 1} lines</span></summary>{code_block("css", css[f].splitlines())}</details>'
        for f in CSS_FILES)
    body.append('<section class="ds-sec ds-appx" id="appendix" aria-labelledby="appendix-h"><header class="ds-ch">'
                '<span class="t-micro">Appendix</span><h2 class="t-h2" id="appendix-h">Foundation source</h2></header>'
                '<p>The six system stylesheets, copied verbatim from <code>system/</code> when this page was built, in load order (section 2.1). '
                'When a value in this page and a foundation file disagree, the file wins (section 0.2).</p>'
                + appx + "</section>")
    body.append(f'<footer class="ds-foot">truex design specification · {esc(version)} · built {today} · '
                f'source <a href="DESIGN-SPEC.md">DESIGN-SPEC.md</a></footer>')

    styles = "\n".join(f"/* ── {f} (verbatim) ── */\n{css[f]}" for f in CSS_FILES)
    page = f"""<!doctype html>
<html lang="en" data-theme="auto" data-contrast="system" data-eff-theme="light" data-eff-contrast="normal" data-eff-motion="full">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>truex · Design spec v2 — application contract</title>
<meta name="description" content="The truex application design specification, version 2: foundations, components, screens and review rules.">
<script>{RESOLVER}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,300..800&family=Instrument+Serif:ital@0;1&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
{styles}
{PAGE_CSS}
</style>
</head>
<body>
{SPRITE}
<div class="ds-page">{rail}<main>{hero_html}{"".join(body)}</main></div>
<script>{PAGE_JS}</script>
</body>
</html>
"""
    OUT.write_text(page, encoding="utf-8")

    # integrity: every in-page link resolves, every heading made it across
    ids = set(re.findall(r'\sid="([^"]+)"', page))
    broken = sorted({h for h in re.findall(r'<a [^>]*href="#([^"]+)"', page) if h not in ids})
    missing = [h[3] for h in HEADINGS if h[2] != "Contents" and h[3] not in ids]
    print(f"wrote {OUT.relative_to(SYS.parent)} · {len(page):,} bytes · {len(sections)} chapters · "
          f"{sum(len(s['subs']) for s in sections)} sections · {len(SPECIMENS)} specimens")
    if broken or missing:
        print("broken anchors:", broken, "\nmissing headings:", missing, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    build()
