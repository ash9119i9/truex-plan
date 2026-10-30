#!/usr/bin/env python3
"""Build system/DESIGN-SPEC.html from system/DESIGN-SPEC.md.

The markdown is the contract; this page is a rendering of it, nothing more.
Every heading, table row, list item and code block in the .md appears here.
The page loads the real foundation CSS (type, color, space, corner,
primitives, patterns), so swatches, type, corners and controls are live, and
adds specimens and screen captures (spec-shots/) after selected headings.

usage: python3 -I system/build-spec.py
"""
import html
import re
from pathlib import Path

SYS = Path(__file__).resolve().parent
MD = SYS / "DESIGN-SPEC.md"
OUT = SYS / "DESIGN-SPEC.html"
SHOTS = SYS / "spec-shots"

esc = lambda s: html.escape(s, quote=False)
attr = lambda s: html.escape(s, quote=True)


# ── source facts the specimens read ──────────────────────────────────────────
def css_vars(path, block_start):
    """Custom properties declared in the first block that starts at block_start."""
    text = (SYS / path).read_text()
    i = text.index(block_start)
    block = text[i:text.index("}", i)]
    return re.findall(r"--([a-z0-9-]+)\s*:\s*([^;]+);", block)

COLOR = [n for n, v in css_vars("color.css", ":root,\n[data-ctx=\"light\"]") if n != "focus"]
COLOR_SET = set(COLOR)
SPACE = css_vars("space.css", ":root {")
SP = [(n, v.split("/*")[0].strip()) for n, v in SPACE if n.startswith("sp-")]
RADII = [(n, v.split("/*")[0].strip()) for n, v in SPACE if n.startswith("r-") or n == "r"]
SHADOWS = [n for n, _ in SPACE if n.startswith("sh-") or n == "key"]


def sprite():
    """Every symbol the screens ship (chat first, then the panel's extras) plus rev-02 n-*."""
    seen, out = set(), []
    for f, keep in (("screens/chat.html", "i-"), ("screens/business-activity.html", "i-"), ("icon-foundations.html", "n-")):
        for m in re.finditer(r'<symbol id="([a-z0-9-]+)".*?</symbol>', (SYS / f).read_text(), re.S):
            if m[1].startswith(keep) and m[1] not in seen:
                seen.add(m[1])
                out.append((m[1], m[0]))
    return out

SPRITE = sprite()


# ── inline markdown ──────────────────────────────────────────────────────────
def slug(text):
    """GitHub-style anchor, so the .md's own #links keep working."""
    t = re.sub(r"[`*_\[\]]", "", text).strip().lower()
    t = re.sub(r"[^\w\- ]", "", t)
    return t.replace(" ", "-")


def swatch(code):
    if re.fullmatch(r"#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?", code):
        return f'<span class="sw" style="--c:{code}" aria-hidden="true"></span>'
    name = code[2:] if code.startswith("--") else None
    if name in COLOR_SET:
        return (f'<span class="sw2" aria-hidden="true" title="light · dark">'
                f'<i data-ctx="light" style="background:var(--{name})"></i>'
                f'<i data-ctx="dark" style="background:var(--{name})"></i></span>')
    return ""


def inline(s, in_table=False):
    codes = []

    def keep(c):
        codes.append(c)
        return f"\x00{len(codes) - 1}\x00"

    s = re.sub(r"``\s?(.+?)\s?``|`([^`]+)`", lambda m: keep(m[1] if m[1] is not None else m[2]), s)
    s = esc(s)
    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: f'<a href="{attr(html.unescape(m[2]))}">{m[1]}</a>', s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\w*\\])\*(?![\s*])(.+?)(?<![\s\\])\*(?![\w*])", r"<em>\1</em>", s)

    def back(m):
        c = codes[int(m[1])]
        return (swatch(c) if in_table else "") + f"<code>{esc(c)}</code>"

    return re.sub(r"\x00(\d+)\x00", back, s)


def cells(row):
    """Split a table row on | outside code spans; \\| is a literal bar."""
    row = row.strip()
    if row.startswith("|"):
        row = row[1:]
    if row.endswith("|") and not row.endswith("\\|"):
        row = row[:-1]
    out, cur, tick = [], "", False
    i = 0
    while i < len(row):
        ch = row[i]
        if ch == "\\" and i + 1 < len(row) and row[i + 1] == "|":
            cur += "|"
            i += 2
            continue
        if ch == "`":
            tick = not tick
        if ch == "|" and not tick:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
        i += 1
    out.append(cur.strip())
    return out


# ── block markdown ───────────────────────────────────────────────────────────
LIST_RE = re.compile(r"^(\s*)([-*]|\d+\.)\s+(.*)$")


def render_list(lines):
    """Nested lists from indentation. lines: raw list lines (items + continuations)."""
    items = []  # (indent, ordered, text)
    for ln in lines:
        m = LIST_RE.match(ln)
        if m:
            items.append([len(m[1]), m[2][-1] == ".", m[3], m[2]])
        elif items:
            items[-1][2] += " " + ln.strip()
    out, stack = [], []  # stack of (indent, tag)
    for indent, ordered, text, marker in items:
        tag = "ol" if ordered else "ul"
        while stack and indent < stack[-1][0]:
            out.append(f"</li></{stack.pop()[1]}>")
        if not stack or indent > stack[-1][0]:
            start = f' start="{marker[:-1]}"' if ordered and marker[:-1] != "1" else ""
            out.append(f"<{tag}{start}>")
            stack.append((indent, tag))
        else:
            out.append("</li>")
        out.append(f"<li>{inline(text)}")
    while stack:
        out.append(f"</li></{stack.pop()[1]}>")
    return "".join(out)


def render_table(rows):
    head = cells(rows[0])
    body = [cells(r) for r in rows[2:]]
    th = "".join(f"<th>{inline(c, True)}</th>" for c in head)
    trs = "".join("<tr>" + "".join(f"<td>{inline(c, True)}</td>" for c in r) + "</tr>" for r in body)
    return f'<div class="tbl"><table class="spec"><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>'


def blocks(md_lines):
    """Yield (kind, payload) for every block in the document body."""
    i, n = 0, len(md_lines)
    while i < n:
        ln = md_lines[i]
        if not ln.strip():
            i += 1
            continue
        if ln.startswith("```"):
            lang = ln[3:].strip()
            j = i + 1
            while not md_lines[j].startswith("```"):
                j += 1
            yield "code", (lang, "\n".join(md_lines[i + 1:j]))
            i = j + 1
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", ln)
        if m:
            yield f"h{len(m[1])}", m[2].strip()
            i += 1
            continue
        if re.match(r"^-{3,}\s*$", ln):
            yield "hr", None
            i += 1
            continue
        if ln.startswith("|"):
            j = i
            while j < n and md_lines[j].startswith("|"):
                j += 1
            yield "table", md_lines[i:j]
            i = j
            continue
        if ln.startswith(">"):
            j = i
            while j < n and md_lines[j].startswith(">"):
                j += 1
            yield "quote", " ".join(l.lstrip("> ").strip() for l in md_lines[i:j])
            i = j
            continue
        if LIST_RE.match(ln):
            j = i
            while j < n and md_lines[j].strip() and (LIST_RE.match(md_lines[j]) or md_lines[j].startswith(" ")):
                j += 1
            yield "list", md_lines[i:j]
            i = j
            continue
        j = i
        while j < n and md_lines[j].strip() and not re.match(r"^(#{1,4}\s|```|\||>|-{3,}\s*$)", md_lines[j]) and not LIST_RE.match(md_lines[j]):
            j += 1
        yield "p", " ".join(l.strip() for l in md_lines[i:j])
        i = j


# ── specimens (inserted after a numbered heading) ────────────────────────────
def png_size(path):
    """(width, height) from the PNG header."""
    b = path.read_bytes()[16:24]
    return int.from_bytes(b[:4], "big"), int.from_bytes(b[4:], "big")


def shots(*items):
    figs, tall = [], True
    for name, cap, link in items:
        f = SHOTS / f"{name}.png"
        if not f.exists():
            continue
        w, h = png_size(f)
        tall = tall and h > 1.3 * w
        figs.append(f'<figure><a href="{link}"><img src="spec-shots/{name}.png" alt="{attr(cap)}" loading="lazy" width="{w}" height="{h}"></a>'
                    f'<figcaption>{esc(cap)} · <a href="{link}">open study</a></figcaption></figure>')
    return f'<div class="shots{" tall" if tall else ""}">{"".join(figs)}</div>' if figs else ""


def live(body, label="Live · rendered by primitives.css"):
    return f'<div class="live" role="group" aria-label="{attr(label)}"><span class="live-k">{esc(label)}</span>{body}</div>'


def ic(name, cls="tx-ic"):
    return f'<svg class="{cls}" aria-hidden="true"><use href="#{name}"/></svg>'


TYPE_ROLES = [
    ("t-hero", "Hero", "Agents at work"), ("t-display", "Display", "Close September"),
    ("t-h2", "Section", "The room knows <em>where you are.</em>"), ("t-h3", "Sub-head", "September closes <em>with two exceptions.</em>"),
    ("t-h4", "Card title", "Plan ready for review"), ("t-lede", "Lede", "Post two accruals, reconcile 412 ledger lines and write the audit trail."),
    ("t-body", "Body", "The agent pauses after every write and asks before it changes anything outside the workspace."),
    ("t-ui", "Control", "Approve &amp; run"), ("t-meta", "Meta", "Updated 4m ago · 3 sources"),
    ("t-micro", "Micro", "TURN 04 · STREAM · 00:04:38"), ("t-editorial", "Editorial", "a one-page plan"),
    ("t-num", "Numeral", "61,400"), ("t-code", "Code", "update_deal(id=4021, stage=\"Q4\")"),
]


def type_specimen():
    rows = "".join(f'<div class="ty-row"><span class="ty-k">{label}<code>.{cls}</code></span><div class="{cls} ty-s">{sample}</div></div>'
                   for cls, label, sample in TYPE_ROLES)
    return live(rows, "Live · the thirteen roles from type.css")


def colour_specimen():
    groups = [("Chassis", ["page", "surface", "surface-2", "well", "well-2", "inv", "line", "line-strong", "ctl", "ink", "ink-2", "ink-3"]),
              ("Signal", ["signal", "signal-fill", "signal-hover", "signal-ink", "signal-soft", "signal-soft-2"]),
              ("Status", ["ok", "ok-ink", "ok-soft", "warn", "warn-ink", "warn-soft", "bad", "bad-ink", "bad-soft"]),
              ("Identity", [n for n in COLOR if n.startswith("id-") and not n.endswith(("-ink", "-soft"))]),
              ("Chart", [n for n in COLOR if n.startswith("cx-")])]
    decks = []
    for ctx in ("light", "light+", "dark", "dark+"):
        body = "".join(f'<div class="cg"><span class="cg-k">{g}</span><div class="cg-row">' +
                       "".join(f'<span class="chip-sw" title="--{t}"><i style="background:var(--{t})"></i><code>{t}</code></span>' for t in toks if t in COLOR_SET) +
                       "</div></div>" for g, toks in groups)
        decks.append(f'<div class="ctx" data-ctx="{ctx}"><div class="ctx-h">{ctx}</div>{body}</div>')
    return live(f'<div class="ctx-grid">{"".join(decks)}</div>', "Live · every context from color.css, side by side")


def space_specimen():
    rows = "".join(f'<div class="sp-row"><code>--{n}</code><span class="sp-bar" style="width:var(--{n})"></span><span class="num">{v}</span></div>' for n, v in SP)
    return live(rows, "Live · the lattice from space.css")


def radius_specimen():
    tiles = "".join(f'<div class="rd-tile"><span style="border-radius:var(--{n})"></span><code>--{n}</code><small class="num">{v}</small></div>' for n, v in RADII)
    return live(f'<div class="rd-grid">{tiles}</div>', "Live · radius ladder with corner.css shape")


def shadow_specimen():
    tiles = "".join(f'<div class="sh-tile" style="box-shadow:var(--{n})"><code>--{n}</code></div>' for n in SHADOWS)
    return live(f'<div class="sh-grid">{tiles}</div>', "Live · elevation from space.css (switch theme to see dark)")


def icon_specimen():
    cells_ = "".join(f'<div class="ic-cell{" rev02" if i.startswith("n-") else ""}"><svg class="tx-ic tx-ic-lg" aria-hidden="true"><use href="#{i}"/></svg><code>{i}</code></div>' for i, _ in SPRITE)
    return live(f'<div class="ic-grid">{cells_}</div>', f"Live · {len(SPRITE)} symbols shipped in the screens; n-* are the rev-02 samples")


def brand_specimen():
    return live('<div class="row"><span class="app-mark-demo" aria-hidden="true"><svg viewBox="0 0 24 24"><ellipse cx="8.6" cy="12" rx="2.2" ry="3" fill="currentColor"/><ellipse cx="15.4" cy="12" rx="2.2" ry="3" fill="currentColor"/></svg></span>'
                '<span class="pt-brand-word brand-demo">truex</span></div>', "Live · application mark and wordmark")


P = {  # primitive galleries, keyed by heading number
    "9.4": '<div class="row"><button class="tx-btn tx-primary" type="button">' + ic("i-run", "tx-ic tx-ic-sm") + 'Approve &amp; run <span class="tx-kbd">⌘↵</span></button>'
           '<button class="tx-btn" type="button">Review</button><button class="tx-btn tx-ghost" type="button">Cancel</button>'
           '<button class="tx-btn tx-danger" type="button">Stop session</button><button class="tx-btn tx-icon tx-ghost" type="button" aria-label="Search">' + ic("i-search") + '</button>'
           '<button class="tx-btn" type="button" disabled><span class="tx-spin" aria-hidden="true"></span>Working…</button></div>'
           '<div class="row"><button class="tx-btn tx-lg tx-primary" type="button">Large</button><button class="tx-btn" type="button">Default</button>'
           '<button class="tx-btn tx-sm" type="button">Small</button><button class="tx-btn tx-xs" type="button">Extra small</button></div>',
    "9.5": '<div class="row"><span class="tx-kbd">⌘K</span><span class="tx-kbd">Esc</span><span class="tx-keys"><span class="tx-kbd">⌘</span><span class="tx-kbd">⇧</span><span class="tx-kbd">P</span></span></div>',
    "9.6": '<div class="row"><span class="tx-pill tx-pill-ok"><span aria-hidden="true">✓</span>Ready</span><span class="tx-pill tx-pill-warn"><span aria-hidden="true">!</span>Needs auth</span>'
           '<span class="tx-pill tx-pill-bad"><span aria-hidden="true">×</span>Failed</span><span class="tx-pill tx-pill-live"><span class="tx-pulse" aria-hidden="true"></span>Running</span>'
           '<span class="tx-pill">Draft</span><span class="tx-pill tx-pill-line">Main</span><span class="tx-pill tx-pill-inv">T4</span><span class="tx-pill tx-pill-sm tx-pill-ok">small</span></div>',
    "9.7": '<div class="row"><button class="tx-chip" type="button" aria-pressed="true">Reads</button><button class="tx-chip" type="button" aria-pressed="false">Writes</button>'
           '<button class="tx-chip" type="button" aria-pressed="false">Secrets</button><button type="button" class="tx-chip tx-chip-ref">tr_7f3a91c2</button></div>',
    "9.8": '<div class="row"><span class="tx-tile">' + ic("i-tool") + '</span><span class="tx-tile tx-tile-signal">' + ic("i-run") + '</span><span class="tx-tile tx-tile-ok"><span aria-hidden="true">✓</span></span>'
           '<span class="tx-tile tx-tile-warn"><span aria-hidden="true">!</span></span><span class="tx-tile tx-tile-bad"><span aria-hidden="true">×</span></span><span class="tx-tile tx-tile-inv">' + ic("i-agent") + '</span>'
           '<span class="tx-tile tx-tile-sm">' + ic("i-search", "tx-ic tx-ic-sm") + '</span><span class="tx-tile tx-tile-lg">' + ic("i-trace", "tx-ic tx-ic-lg") + '</span></div>',
    "9.9": '<div class="row"><div class="tx-seg" role="group" aria-label="Scope" data-seg><button type="button" aria-pressed="true">This turn</button><button type="button" aria-pressed="false">Session</button><button type="button" aria-pressed="false">Project</button></div>'
           '<div class="tx-seg tx-seg-sm" role="group" aria-label="Density" data-seg><button type="button" aria-pressed="false">Comfortable</button><button type="button" aria-pressed="true">Compact</button></div></div>',
    "9.10": '<div class="tx-tabs" role="tablist" aria-label="Activity panel" data-tabs><button role="tab" aria-selected="true">Activity</button><button role="tab" aria-selected="false" tabindex="-1">Sub-agents</button>'
            '<button role="tab" aria-selected="false" tabindex="-1">Files</button><button role="tab" aria-selected="false" tabindex="-1">Insights</button></div>',
    "9.11": '<div class="fields"><div class="tx-field"><label for="sp-name">Session name <span class="tx-req" aria-hidden="true">*</span></label><input class="tx-input" id="sp-name" type="text" value="Onboarding plan for new analysts" aria-required="true">'
            '<span class="tx-hint">Shown in the session list and the topbar crumb.</span></div>'
            '<div class="tx-field"><label for="sp-key">API token</label><div class="tx-secret"><input class="tx-input" id="sp-key" type="password" value="ya29-example-redacted" autocomplete="off">'
            '<button class="tx-reveal" type="button" aria-pressed="false" aria-controls="sp-key" aria-label="Show token" data-reveal><span class="rv-tx">Show</span></button></div><span class="tx-hint">Stored in the OS keychain, never the session.</span></div>'
            '<div class="tx-field"><label for="sp-sel">Model</label><select class="tx-input tx-select" id="sp-sel"><option>Sonnet 5.5</option><option>Opus 5.5</option><option>Haiku 5.5</option></select></div>'
            '<div class="tx-field"><label for="sp-bad">Ticket</label><input class="tx-input" id="sp-bad" value="ONB" aria-invalid="true" aria-describedby="sp-bad-e"><span class="tx-errmsg" id="sp-bad-e">Use the full id, like ONB-412.</span></div></div>',
    "9.12": '<div class="row"><label class="sw-l"><input class="tx-switch" type="checkbox" role="switch" checked> Auto-approve reads</label><label class="sw-l"><input class="tx-switch" type="checkbox" role="switch"> Show hit area</label>'
            '<label class="sw-l"><input class="tx-switch" type="checkbox" role="switch" disabled> Disabled</label></div>',
    "9.13": '<nav class="tx-menu" aria-label="Turn actions" style="max-width:20rem"><div class="tx-menu-h">Turn</div><button class="tx-menu-item" type="button"><span>Steer the agent<small>Interrupt without losing the plan</small></span><span class="tx-kbd">S</span></button>'
            '<button class="tx-menu-item" type="button"><span>Retry turn<small>Re-run from the last prompt</small></span><span class="tx-kbd">R</span></button><div class="tx-menu-sep" role="separator"></div>'
            '<button class="tx-menu-item" type="button"><span>Copy transcript</span><span class="tx-kbd">⌘C</span></button><div class="tx-menu-sep" role="separator"></div>'
            '<button class="tx-menu-item tx-menu-danger" type="button"><span>Stop session</span><span class="tx-kbd">Del</span></button></nav>',
    "9.14": '<div class="row tip-row"><span class="tx-tip"><button class="tx-btn" type="button" aria-describedby="sp-tt-1">Last run</button><span class="tx-tip-pop" role="tooltip" id="sp-tt-1">2m 04s · 48.0k tokens</span></span>'
            '<span class="tx-tip tx-tip-up"><button class="tx-btn tx-icon tx-ghost" type="button" aria-label="Context usage" aria-describedby="sp-tt-2">' + ic("i-trace") + '</button><span class="tx-tip-pop" role="tooltip" id="sp-tt-2">Context 61.4k of 258k (24%)</span></span>'
            '<span class="t-meta muted">Hover or focus a control.</span></div>',
    "9.15": '<div class="tx-toast" style="position:static"><span class="tx-tile tx-tile-ok"><span aria-hidden="true">✓</span></span><div><h5>Checklist saved</h5><p>18 of 30 rows saved.</p></div><span class="tx-toast-x" aria-hidden="true">×</span></div>',
    "9.16": '<div class="meters">' + "".join(f'<div class="m-row"><span>{k}</span><div class="tx-meter {c}" style="--tx-p:{p}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="{p}" aria-label="{k}"><i></i></div><span class="num">{p}%</span></div>'
            for k, c, p in (("Goal", "tx-meter-signal", 28), ("Context", "", 24), ("5h window", "tx-meter-warn", 72), ("Disk", "tx-meter-bad tx-meter-lg", 94), ("Checks", "tx-meter-ok", 100))) +
            '</div><div class="row"><span class="tx-ring" style="--tx-p:24"><span class="num">24%</span></span><span class="tx-ring" style="--tx-p:72;--tx-c:var(--warn)"><span class="num">72%</span></span>'
            '<div class="tx-bar" style="width:12rem"><i class="tx-stripes" style="width:60%"></i></div></div>',
    "9.17": '<div class="row"><span class="tx-pill tx-pill-live"><span class="tx-spin" aria-hidden="true"></span>Working</span><span class="tx-shimmer">Thinking…</span><span>Writing checklist<span class="tx-caret"></span></span>'
            '<span class="tx-dot tx-dot-live" aria-hidden="true"></span><span class="tx-dot tx-dot-ok" aria-hidden="true"></span><span class="tx-dot tx-dot-warn" aria-hidden="true"></span><span class="tx-dot tx-dot-bad" aria-hidden="true"></span><span class="tx-dot tx-dot-off" aria-hidden="true"></span>'
            '<span class="tx-tape">needs auth</span></div><div class="skels"><span class="tx-skel" style="height:.75rem;width:70%"></span><span class="tx-skel" style="height:.75rem;width:90%"></span><span class="tx-skel" style="height:.75rem;width:55%"></span></div>',
    "9.18": '<div class="states"><div class="tx-card tx-card-pad tx-state"><span class="tx-tile tx-tile-lg">' + ic("i-search", "tx-ic tx-ic-lg") + '</span><h4>No sessions yet</h4><p>Start a session to see turns, plans and files here.</p><button class="tx-btn tx-primary tx-sm" type="button">New session</button></div>'
            '<div class="tx-card tx-card-pad tx-state" aria-busy="true"><span class="tx-tile tx-tile-lg tx-tile-signal"><span class="tx-spin" aria-hidden="true"></span></span><h4><span class="tx-shimmer">Loading activity…</span></h4><p>Reading four turns.</p></div>'
            '<div class="tx-card tx-card-pad tx-state tx-state-error"><span class="tx-tile tx-tile-lg tx-tile-bad"><span aria-hidden="true">×</span></span><h4>Couldn’t load activity</h4><p>The trace store didn’t answer. Nothing was lost.</p><button class="tx-btn tx-sm" type="button">Try again</button></div></div>',
}

CH = "screens/"
SPECIMENS = {
    "2.4": brand_specimen,
    "3.3": type_specimen,
    "4.7": colour_specimen,
    "5.1": space_specimen,
    "5.7": shadow_specimen,
    "6.1": radius_specimen,
    "7.3": icon_specimen,
    "10": lambda: shots(("patterns", "06 Patterns · the room, live specimen", "06-patterns.html")),
    "11": lambda: shots(("chat-light", "Chat · new conversation, light", CH + "chat.html?theme=light"), ("chat-dark", "Chat · new conversation, dark", CH + "chat.html?theme=dark")),
    "11.7": lambda: shots(("chat-turn", "Turn in flight · reasoning, helpers, a helper waiting on you", CH + "chat.html")),
    "12.5": lambda: shots(("turn-error", "TurnError · /error", CH + "chat.html")),
    "12.7": lambda: shots(("req-plan", "Plan card and plan approval · /plan", CH + "chat.html")),
    "13": lambda: shots(("req-tool", "Tool approval · /ask tool", CH + "chat.html"), ("req-ask", "Question · /ask", CH + "chat.html"), ("req-elicit", "MCP elicitation · /elicit", CH + "chat.html")),
    "14": lambda: shots(("activity-light", "Tab 1 · Activity, needs you", CH + "business-activity.html?tab=activity"), ("activity-dark", "Tab 1 · dark", CH + "business-activity.html?tab=activity&theme=dark"),
                        ("activity-agent", "Tab 2 · Sub-agents", CH + "business-activity.html?tab=agent"), ("activity-files", "Tab 3 · Files", CH + "business-activity.html?tab=files"),
                        ("activity-insights", "Tab 4 · Insights", CH + "business-activity.html?tab=insights")),
    "15": lambda: shots(("agents-light", "Team board · light", CH + "agents.html?theme=light"), ("agents-dark", "Team board · dark", CH + "agents.html?theme=dark"), ("agent-id", "Agent ID desk · identity step", CH + "agent-id.html")),
    "16": lambda: shots(("charts", "Chart studies", "chart-studies.html")),
}
for k, v in P.items():
    SPECIMENS[k] = (lambda body: lambda: live(body))(v)


def num_of(title):
    m = re.match(r"^(\d+(?:\.\d+)?)\.?\s", title)
    return m[1] if m else None


# ── page ─────────────────────────────────────────────────────────────────────
def build():
    lines = MD.read_text().splitlines()
    title = re.sub(r"^#\s+", "", lines[0])
    # the preamble is everything before the first ---; Contents is replaced by the rail
    first_hr = next(i for i, l in enumerate(lines) if re.match(r"^-{3,}\s*$", l))
    pre = [b for b in blocks(lines[1:first_hr])]
    body_lines = lines[first_hr + 1:]
    c0 = next(i for i, l in enumerate(body_lines) if l.startswith("## Contents"))
    c1 = next(i for i in range(c0 + 1, len(body_lines)) if body_lines[i].startswith("## "))
    body_lines = body_lines[:c0] + body_lines[c1:]

    version = pre[0][1] if pre and pre[0][0] == "p" else ""
    intro = "".join(f"<p>{inline(t)}</p>" for k, t in pre[1:] if k == "p")

    main, rail, open_sec, stats = [], [], False, {"h2": 0, "h3": 0, "table": 0, "rows": 0, "code": 0, "list": 0, "items": 0}
    used_ids = set()
    for kind, data in blocks(body_lines):
        if kind in ("h2", "h3", "h4"):
            sid = slug(data)
            while sid in used_ids:
                sid += "-x"
            used_ids.add(sid)
            stats[kind] = stats.get(kind, 0) + 1
            n = num_of(data)
            if kind == "h2":
                if open_sec:
                    main.append("</section>")
                no = f'<span class="sec-no" aria-hidden="true">{int(n):02d}</span>' if n and n.isdigit() else ""
                text = re.sub(r"^\d+\.\s+", "", data) if no else data
                sr = f'<span class="tx-sr">{n}. </span>' if no else ""
                main.append(f'<section class="sec" id="{sid}" aria-labelledby="{sid}-h">{no}<h2 id="{sid}-h">{sr}{inline(text)}</h2>')
                rail.append(f'<li class="h2"><a href="#{sid}">{inline(data)}</a></li>')
                open_sec = True
            else:
                main.append(f'<{kind} id="{sid}">{inline(data)}</{kind}>')
                if kind == "h3":
                    rail.append(f'<li class="h3"><a href="#{sid}">{inline(data)}</a></li>')
            if n and n in SPECIMENS:
                main.append(SPECIMENS[n]())
        elif kind == "p":
            main.append(f"<p>{inline(data)}</p>")
        elif kind == "quote":
            main.append(f'<p class="note">{inline(data)}</p>')
        elif kind == "list":
            stats["list"] += 1
            stats["items"] += sum(1 for l in data if LIST_RE.match(l))
            main.append(render_list(data))
        elif kind == "table":
            stats["table"] += 1
            stats["rows"] += len(data) - 2
            main.append(render_table(data))
        elif kind == "code":
            stats["code"] += 1
            lang, code = data
            tag = f'<span class="pre-k">{esc(lang)}</span>' if lang else ""
            main.append(f'<div class="pre">{tag}<pre><code>{esc(code)}</code></pre></div>')
        elif kind == "hr":
            pass
    if open_sec:
        main.append("</section>")

    sym = "".join(s for _, s in SPRITE)
    meta = "".join(f"<span>{esc(x.strip())}</span>" for x in re.sub(r"[`*]", "", version).split("·")[:2])
    intro = f'<p class="t-meta version">{inline(version)}</p>' + intro
    page = TEMPLATE.format(
        title=esc(title), sprite=sym, rail="".join(rail), intro=intro, meta=meta,
        counts=f'<span>{stats["h2"]} chapters · {stats["h3"]} sections</span><span>{stats["table"]} tables · {stats["rows"]} rows</span>',
        main="\n".join(main))
    OUT.write_text(page)
    print(f"wrote {OUT.relative_to(SYS.parent)} · {len(page):,} bytes · {stats}")


TEMPLATE = """<!doctype html>
<html lang="en" data-theme="auto" data-eff-theme="light" data-eff-contrast="normal" data-eff-motion="full">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · v2</title>
<meta name="description" content="The truex application design specification, version 2, rendered from system/DESIGN-SPEC.md on the live foundation CSS.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect x='3' y='7' width='34' height='30' rx='11' fill='%233691CD'/%3E%3Cellipse cx='14.5' cy='21' rx='3' ry='4' fill='white'/%3E%3Cellipse cx='25.5' cy='21' rx='3' ry='4' fill='white'/%3E%3C/svg%3E">
<!-- generated by build-spec.py from DESIGN-SPEC.md; edit the .md, then rebuild -->
<script>
(function () {{
  var r = document.documentElement, pref = "auto", contrast = "system";
  try {{ pref = localStorage.getItem("tx-sys-theme") || "auto"; contrast = localStorage.getItem("tx-sys-contrast") || "system"; }} catch (e) {{}}
  var q = new URLSearchParams(location.search);
  if (["auto", "light", "dark"].indexOf(q.get("theme")) > -1) pref = q.get("theme");
  if (["system", "normal", "more"].indexOf(q.get("contrast")) > -1) contrast = q.get("contrast");
  r.dataset.theme = pref;
  r.dataset.contrast = contrast;
  var dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  var more = contrast === "more" || (contrast === "system" && matchMedia("(prefers-contrast: more)").matches);
  r.dataset.effTheme = dark ? "dark" : "light";
  r.dataset.effContrast = more ? "more" : "normal";
  r.dataset.effMotion = matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "full";
}})();
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,300..800&family=Instrument+Serif:ital@0;1&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="type.css">
<link rel="stylesheet" href="color.css">
<link rel="stylesheet" href="space.css">
<link rel="stylesheet" href="corner.css">
<link rel="stylesheet" href="primitives.css">
<link rel="stylesheet" href="patterns.css">
<style>
/* Layout: sticky contents rail on the left, one reading column on the right; stacks on phones.
   Every value is a system token, so the page itself demonstrates the system it specifies. */
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: var(--page); color: var(--ink); }}
.sprite {{ position: absolute; width: 0; height: 0; overflow: hidden; }}
.skip {{ position: absolute; left: var(--sp-4); top: -4rem; z-index: 9; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--inv); color: var(--on-inv); }}
.skip:focus {{ top: var(--sp-4); }}
.page {{ display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); gap: var(--sp-7); max-width: var(--wrap); margin: 0 auto; padding: var(--sp-6) var(--gutter) var(--sp-9); }}

.rail {{ position: sticky; top: var(--sp-5); align-self: start; max-height: calc(100vh - var(--sp-6)); overflow: auto; font-size: var(--t-meta); padding-right: var(--sp-2); overscroll-behavior: contain; }}
.rail-brand {{ display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-1); }}
.rail-brand .pt-brand-word {{ font-size: var(--t-h3); }}
.rail-sub {{ font: 600 var(--t-micro)/var(--lh-micro) var(--f-mono); letter-spacing: var(--tr-micro); text-transform: uppercase; color: var(--ink-3); margin-bottom: var(--sp-4); }}
.rail-tools {{ display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-4); }}
.rail-filter {{ width: 100%; margin-bottom: var(--sp-3); }}
.rail ol {{ list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }}
.rail a {{ display: block; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-sm); color: var(--ink-2); text-decoration: none; line-height: var(--lh-ui); }}
.rail a:hover {{ background: var(--well); color: var(--ink); }}
.rail a[aria-current="true"] {{ background: var(--signal-soft); color: var(--signal-ink); font-weight: 600; }}
.rail .h2 a {{ font-weight: 600; color: var(--ink); margin-top: var(--sp-1); }}
.rail .h3 a {{ padding-left: var(--sp-5); font-size: var(--t-micro); font-family: var(--f-mono); color: var(--ink-3); }}
.rail.js .h3:not(.open) {{ display: none; }}
.rail .hide {{ display: none !important; }}

main {{ min-width: 0; }}
.hero {{ padding: var(--sp-5) 0 var(--sp-6); border-bottom: 1px solid var(--line); }}
.hero .kick {{ font: 600 var(--t-micro)/var(--lh-micro) var(--f-mono); letter-spacing: var(--tr-micro); text-transform: uppercase; color: var(--ink-3); margin-bottom: var(--sp-4); }}
.hero h1 {{ margin-bottom: var(--sp-4); }}
.hero p {{ max-width: var(--measure-lede); color: var(--ink-2); }}
.meta {{ display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-5); }}
.meta span {{ display: inline-flex; align-items: center; height: 1.75rem; padding: 0 var(--sp-3); border: 1px solid var(--line); border-radius: var(--r-pill); background: var(--surface); font: 500 var(--t-micro) var(--f-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }}

.sec {{ padding-top: var(--sp-8); }}
.sec-no {{ display: block; font: 400 var(--t-editorial)/1 var(--f-serif); font-style: italic; color: var(--signal-ink); margin-bottom: var(--sp-2); }}
.sec h2 {{ font-size: var(--t-h3); line-height: var(--lh-h3); letter-spacing: var(--tr-h3); font-variation-settings: var(--cut-heading); font-weight: 760; padding-bottom: var(--sp-4); border-bottom: 1px solid var(--line); margin-bottom: var(--sp-4); scroll-margin-top: var(--sp-5); }}
.sec h3 {{ font-size: var(--t-h4); line-height: var(--lh-h4); letter-spacing: var(--tr-h4); margin: var(--sp-6) 0 var(--sp-3); scroll-margin-top: var(--sp-5); }}
.sec h4 {{ font-size: var(--t-ui); margin: var(--sp-5) 0 var(--sp-2); scroll-margin-top: var(--sp-5); }}
.sec {{ scroll-margin-top: var(--sp-5); }}
.sec p, .sec li {{ max-width: var(--measure-meta); color: var(--ink-2); }}
.sec strong {{ color: var(--ink); font-weight: 650; }}
.sec ul, .sec ol {{ padding-left: var(--sp-5); margin: 0 0 var(--sp-3); }}
.sec li {{ margin: var(--sp-1) 0; }}
.sec li > ul, .sec li > ol {{ margin: var(--sp-1) 0 0; }}
.note {{ padding: var(--sp-3) var(--sp-4); border-radius: var(--r); background: var(--signal-soft); color: var(--ink) !important; }}
a {{ color: var(--signal-ink); text-underline-offset: 2px; }}
code {{ padding: 0 .3em; border-radius: var(--r-xs); background: var(--well); color: var(--ink); overflow-wrap: anywhere; }}
.pre {{ position: relative; margin: var(--sp-3) 0; }}
.pre-k {{ position: absolute; right: var(--sp-3); top: var(--sp-2); font: 600 var(--t-micro) var(--f-mono); letter-spacing: var(--tr-micro); text-transform: uppercase; color: var(--ink-3); }}
pre {{ margin: 0; padding: var(--sp-4); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); overflow-x: auto; line-height: var(--lh-code); }}
pre code {{ padding: 0; background: none; overflow-wrap: normal; white-space: pre; }}

.tbl {{ margin: var(--sp-3) 0 var(--sp-4); border: 1px solid var(--line); border-radius: var(--r); overflow-x: auto; background: var(--surface); }}
table.spec {{ width: 100%; border-collapse: collapse; font-size: var(--t-meta); line-height: var(--lh-meta); }}
table.spec th {{ text-align: left; font: 600 var(--t-micro)/var(--lh-micro) var(--f-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; border-bottom: 1px solid var(--line); }}
table.spec th code {{ text-transform: none; letter-spacing: 0; }}
table.spec td {{ padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--line); vertical-align: top; color: var(--ink); }}
table.spec tr:first-child td {{ border-top: 0; }}
table.spec td:first-child {{ font-weight: 550; }}
table.spec code {{ white-space: nowrap; }}
.sw {{ display: inline-block; width: .875rem; height: .875rem; margin-right: var(--sp-1); vertical-align: -2px; border-radius: var(--r-xs); background: var(--c); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent); }}
.sw2 {{ display: inline-flex; width: 1.25rem; height: .875rem; margin-right: var(--sp-1); vertical-align: -2px; border-radius: var(--r-xs); overflow: hidden; box-shadow: 0 0 0 1px var(--line-strong); }}
.sw2 i {{ flex: 1; }}

.live {{ position: relative; margin: var(--sp-3) 0 var(--sp-5); padding: var(--sp-6) var(--sp-5) var(--sp-5); border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--sh-1); display: flex; flex-direction: column; gap: var(--sp-4); }}
.live-k {{ position: absolute; left: var(--sp-5); top: var(--sp-3); font: 600 var(--t-micro) var(--f-mono); letter-spacing: var(--tr-micro); text-transform: uppercase; color: var(--ink-3); }}
.live .row {{ display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); }}
.live h5 {{ margin: 0; }}
.muted {{ color: var(--ink-3); }}
.ty-row {{ display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: var(--sp-4); align-items: baseline; padding-bottom: var(--sp-3); border-bottom: 1px dashed var(--line); }}
.ty-row:last-child {{ border: 0; padding: 0; }}
.ty-k {{ display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--t-meta); color: var(--ink-3); }}
.ty-k code {{ align-self: start; }}
.ty-s {{ min-width: 0; overflow-wrap: anywhere; }}
.ctx-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: var(--sp-3); }}
.ctx {{ padding: var(--sp-4); border-radius: var(--r); background: var(--page); border: 1px solid var(--line); color: var(--ink); }}
.ctx-h {{ font: 600 var(--t-micro) var(--f-mono); letter-spacing: var(--tr-micro); text-transform: uppercase; margin-bottom: var(--sp-3); }}
.cg {{ margin-bottom: var(--sp-3); }}
.cg-k {{ display: block; font-size: var(--t-micro); color: var(--ink-3); margin-bottom: var(--sp-1); }}
.cg-row {{ display: flex; flex-wrap: wrap; gap: var(--sp-1); }}
.chip-sw {{ display: inline-flex; align-items: center; gap: var(--sp-1); padding: 2px var(--sp-2) 2px 2px; border-radius: var(--r-pill); background: var(--surface); border: 1px solid var(--line); }}
.chip-sw i {{ width: 1rem; height: 1rem; border-radius: 50%; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent); }}
.chip-sw code {{ background: none; padding: 0; font-size: .6875rem; color: var(--ink-2); }}
.sp-row {{ display: grid; grid-template-columns: 5rem minmax(0, 1fr) 6rem; gap: var(--sp-3); align-items: center; font-size: var(--t-meta); }}
.sp-bar {{ height: .75rem; border-radius: var(--r-mark); background: var(--signal); }}
.rd-grid, .sh-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: var(--sp-4); }}
.rd-tile {{ display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--t-meta); }}
.rd-tile code {{ align-self: start; }}
.rv-tx {{ font: 500 .5938rem var(--f-mono); letter-spacing: .04em; text-transform: uppercase; }}
.rd-tile span {{ height: 5rem; background: var(--signal-soft); border: 1px solid var(--signal-soft-2); margin-bottom: var(--sp-1); }}
.sh-tile {{ height: 6rem; display: grid; place-items: center; border-radius: var(--r); background: var(--surface); }}
.ic-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: var(--sp-2); }}
.ic-cell {{ display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2); border-radius: var(--r-sm); background: var(--surface-2); border: 1px solid var(--line); font-size: .6875rem; color: var(--ink-2); }}
.ic-cell svg {{ stroke: currentColor; color: var(--ink); }}
.ic-cell code {{ background: none; padding: 0; }}
.ic-cell.rev02 {{ background: var(--signal-soft); border-color: var(--signal-soft-2); }}
.app-mark-demo {{ display: inline-grid; place-items: center; width: 2.5rem; height: 2.5rem; border-radius: var(--r-sm); background: var(--signal); color: #FFFFFF; }}
.app-mark-demo svg {{ width: 1.75rem; height: 1.75rem; }}
.brand-demo {{ font-size: var(--t-h3); }}
.fields {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: var(--sp-4); }}
.sw-l {{ display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--t-ui); }}
.tip-row {{ padding-top: var(--sp-6); }}
.meters {{ display: flex; flex-direction: column; gap: var(--sp-2); max-width: 26rem; }}
.m-row {{ display: grid; grid-template-columns: 5.5rem minmax(0, 1fr) 3rem; gap: var(--sp-3); align-items: center; font-size: var(--t-meta); }}
.skels {{ display: flex; flex-direction: column; gap: var(--sp-2); max-width: 22rem; }}
.states {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--sp-3); }}

.shots {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: var(--sp-4); margin: var(--sp-3) 0 var(--sp-5); }}
.shots:has(> figure:only-child) {{ max-width: 40rem; }}
.shots.tall {{ grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); }}
.shots figure {{ margin: 0; min-width: 0; }}
.shots img {{ display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--sh-2); }}
.shots figcaption {{ margin-top: var(--sp-2); font: 500 var(--t-micro) var(--f-mono); color: var(--ink-3); }}

:focus-visible {{ outline: 2px solid var(--signal); outline-offset: 2px; }}
.foot {{ margin-top: var(--sp-8); padding-top: var(--sp-4); border-top: 1px solid var(--line); font-size: var(--t-meta); color: var(--ink-3); }}

@media (max-width: 60rem) {{
  .page {{ grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); padding-top: var(--sp-4); }}
  .rail {{ position: static; max-height: none; border-bottom: 1px solid var(--line); padding-bottom: var(--sp-4); }}
  .rail .h3 {{ display: none !important; }}
  .ty-row {{ grid-template-columns: minmax(0, 1fr); gap: var(--sp-1); }}
}}
@media print {{
  .rail, .skip {{ display: none; }}
  .page {{ display: block; }}
  .live, .tbl, pre, .shots figure {{ break-inside: avoid; }}
}}
@media (prefers-reduced-motion: reduce) {{ * {{ animation-duration: 0ms !important; transition-duration: 0ms !important; }} }}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to the spec</a>
<svg class="sprite" aria-hidden="true" focusable="false">{sprite}</svg>
<div class="page">
<nav class="rail" aria-label="Contents">
  <div class="rail-brand"><span class="app-mark-demo" style="width:1.75rem;height:1.75rem" aria-hidden="true"><svg viewBox="0 0 24 24" style="width:1.25rem;height:1.25rem"><ellipse cx="8.6" cy="12" rx="2.2" ry="3" fill="currentColor"/><ellipse cx="15.4" cy="12" rx="2.2" ry="3" fill="currentColor"/></svg></span><span class="pt-brand-word">truex</span></div>
  <div class="rail-sub">Application design spec · v2</div>
  <div class="rail-tools">
    <div class="tx-seg tx-seg-sm" role="group" aria-label="Theme" id="theme-seg">
      <button type="button" data-v="auto" aria-pressed="false">Auto</button><button type="button" data-v="light" aria-pressed="false">Light</button><button type="button" data-v="dark" aria-pressed="false">Dark</button>
    </div>
  </div>
  <input class="tx-input rail-filter" type="search" id="rail-filter" placeholder="Filter sections" aria-label="Filter sections" autocomplete="off">
  <ol id="rail-list">{rail}</ol>
</nav>
<main id="main">
<header class="hero" id="top">
  <div class="kick">truex · system/DESIGN-SPEC.md</div>
  <h1 class="t-display">Application design, <em>specified.</em></h1>
  {intro}
  <div class="meta">{meta}{counts}<span>Light-first · four contexts</span><span>Base 15px Bricolage</span></div>
</header>
{main}
<footer class="foot">Generated from <code>system/DESIGN-SPEC.md</code> by <code>system/build-spec.py</code>. Edit the markdown, then rebuild. Live specimens use the real <code>type · color · space · corner · primitives · patterns</code> CSS; screen captures in <code>spec-shots/</code> (regenerate with <code>node system/spec-shots/shoot.mjs</code>).</footer>
</main>
</div>
<script>
(function () {{
  "use strict";
  var root = document.documentElement, darkMQ = matchMedia("(prefers-color-scheme: dark)");
  var seg = document.getElementById("theme-seg");
  function apply(v, persist) {{
    root.dataset.theme = v;
    root.dataset.effTheme = v === "dark" || (v === "auto" && darkMQ.matches) ? "dark" : "light";
    seg.querySelectorAll("button").forEach(function (b) {{ b.setAttribute("aria-pressed", String(b.dataset.v === v)); }});
    if (persist) try {{ localStorage.setItem("tx-sys-theme", v); }} catch (e) {{}}
  }}
  seg.addEventListener("click", function (e) {{ var b = e.target.closest("button"); if (b) apply(b.dataset.v, true); }});
  darkMQ.addEventListener && darkMQ.addEventListener("change", function () {{ if (root.dataset.theme === "auto") apply("auto"); }});
  apply(root.dataset.theme || "auto");

  // demo controls keep their pressed state honest
  document.querySelectorAll("main [data-seg]").forEach(function (g) {{
    g.addEventListener("click", function (e) {{ var b = e.target.closest("button"); if (!b) return;
      g.querySelectorAll("button").forEach(function (x) {{ x.setAttribute("aria-pressed", String(x === b)); }}); }});
  }});
  document.querySelectorAll("main .tx-chip[aria-pressed]").forEach(function (c) {{
    c.addEventListener("click", function () {{ c.setAttribute("aria-pressed", String(c.getAttribute("aria-pressed") !== "true")); }});
  }});
  document.querySelectorAll("main [data-tabs]").forEach(function (t) {{
    var tabs = [].slice.call(t.querySelectorAll("[role=tab]"));
    function sel(x) {{ tabs.forEach(function (y) {{ y.setAttribute("aria-selected", String(y === x)); y.tabIndex = y === x ? 0 : -1; }}); x.focus(); }}
    t.addEventListener("click", function (e) {{ var x = e.target.closest("[role=tab]"); if (x) sel(x); }});
    t.addEventListener("keydown", function (e) {{ var i = tabs.indexOf(document.activeElement); if (i < 0) return;
      if (e.key === "ArrowRight") {{ sel(tabs[(i + 1) % tabs.length]); e.preventDefault(); }}
      if (e.key === "ArrowLeft") {{ sel(tabs[(i - 1 + tabs.length) % tabs.length]); e.preventDefault(); }} }});
  }});
  document.querySelectorAll("main [data-reveal]").forEach(function (b) {{
    b.addEventListener("click", function () {{ var i = document.getElementById(b.getAttribute("aria-controls")), on = i.type === "password";
      i.type = on ? "text" : "password"; b.setAttribute("aria-pressed", String(on)); b.firstChild.textContent = on ? "Hide" : "Show"; b.setAttribute("aria-label", on ? "Hide token" : "Show token"); }});
  }});

  // rail: highlight the chapter in view and show only its sections
  var rail = document.querySelector(".rail"), list = document.getElementById("rail-list");
  rail.classList.add("js");
  var links = [].slice.call(list.querySelectorAll("a")), byId = {{}};
  links.forEach(function (a) {{ byId[a.getAttribute("href").slice(1)] = a; }});
  var targets = links.map(function (a) {{ return document.getElementById(a.getAttribute("href").slice(1)); }}).filter(Boolean);
  function current() {{
    var y = window.scrollY + 120, cur = targets[0];
    for (var i = 0; i < targets.length; i++) {{ if (targets[i].getBoundingClientRect().top + window.scrollY <= y) cur = targets[i]; else break; }}
    return cur;
  }}
  var last;
  function sync() {{
    var t = current(); if (!t || t === last) return; last = t;
    links.forEach(function (a) {{ a.removeAttribute("aria-current"); }});
    var a = byId[t.id]; if (!a) return;
    a.setAttribute("aria-current", "true");
    var li = a.parentElement, h2 = li.classList.contains("h2") ? li : null;
    for (var p = li; !h2 && p; p = p.previousElementSibling) if (p.classList.contains("h2")) h2 = p;
    list.querySelectorAll(".h3").forEach(function (x) {{ x.classList.remove("open"); }});
    for (var n = h2 && h2.nextElementSibling; n && n.classList.contains("h3"); n = n.nextElementSibling) n.classList.add("open");
    if (a.scrollIntoView && !filter.value) {{ var r = a.getBoundingClientRect(), rr = rail.getBoundingClientRect();
      if (r.top < rr.top || r.bottom > rr.bottom) rail.scrollTop += r.top - rr.top - rr.height / 3; }}
  }}
  var ticking = false;
  window.addEventListener("scroll", function () {{ if (!ticking) {{ ticking = true; requestAnimationFrame(function () {{ ticking = false; sync(); }}); }} }}, {{ passive: true }});
  sync();

  var filter = document.getElementById("rail-filter");
  filter.addEventListener("input", function () {{
    var q = filter.value.trim().toLowerCase();
    rail.classList.toggle("js", !q);
    list.querySelectorAll("li").forEach(function (li) {{ li.classList.toggle("hide", !!q && li.textContent.toLowerCase().indexOf(q) < 0); }});
    if (!q) {{ last = null; sync(); }}
  }});
}})();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    build()
