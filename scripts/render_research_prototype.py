"""Render the headline-first research prototype (``scripts/prototypes/research_story.html``) with a
profile's own cashU data, locally.

Starts the installed cashU.app as a read-only server on a free port (no daily run), reads the research
endpoints of one profile, maps them into the prototype's data shape and writes a standalone HTML file
(default ``build/prototypes/research-twoje-dane.html``, git-ignored). Nothing is printed except the output
path: the data never leaves this machine. Never commit the output.

    python3 scripts/render_research_prototype.py [--profile SLUG] [--out PATH]

``RENDER_DATA_DIR=<dir>`` runs it against another data dir (e.g. the demo) instead of the app's own.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request

APP = "/Applications/cashU.app/Contents/MacOS/cashu"
ANSI = re.compile(r"\x1b\[[0-9;]*m")
WEEKDAY = ["pon", "wt", "śr", "czw", "pt", "sob", "nd"]
WEEKDAY_LONG = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"]
TONE = {"pos": "pos", "neg": "neg", "warn": "warn"}
HEALTH = {
    "invalidated": ["podważona", "neg"], "weakened": ["osłabiona", "neg"], "supported": ["wzmocniona", "pos"],
    "fulfilled": ["spełniona", "pos"], "current": ["bez zmian", "calm"], "no_thesis": ["bez tezy", "calm"],
    "no_research": ["bez researchu", "calm"],
}
REL = {"supports": ["wspiera tezę", "pos"], "weakens": ["osłabia tezę", "neg"], "invalidates": ["podważa tezę", "neg"], "fulfills": ["spełnia tezę", "pos"]}
KIND = {"news": "wiadomość", "earnings": "wyniki", "trend": "trend", "macro": "makro", "community": "społeczność", "candidate": "kandydat"}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start() -> tuple[subprocess.Popen, int, str]:
    port = free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith("CASHU_")}
    env["CASHU_AUTO_DAILY"] = "0"
    if os.environ.get("RENDER_DATA_DIR"):  # a test run against another data dir (demo)
        env["CASHU_DATA_DIR"] = os.environ["RENDER_DATA_DIR"]
    proc = subprocess.Popen([APP, "serve", "--port", str(port)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, text=True)
    deadline = time.time() + 90
    token = None
    while time.time() < deadline and token is None:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                break
            continue
        m = re.search(r"#token=([A-Za-z0-9_\-]+)", ANSI.sub("", line))
        if m:
            token = m.group(1)
    if token is None:
        proc.terminate()
        sys.exit("cashU server did not start")
    # Keep draining the server's output (a full pipe would block it), then wait until it answers.
    threading.Thread(target=lambda: [None for _ in proc.stdout], daemon=True).start()
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                break
        except OSError:
            time.sleep(0.5)
    return proc, port, token


def pp(v: float | None) -> str:
    if v is None:
        return ""
    r = round(v * 100, 1)
    return f"{'+' if r > 0 else ''}{r:.1f}".replace(".", ",").replace("-", "-") + " pp"


def pct(v: float | None) -> str:
    return "" if v is None else f"{v * 100:+.1f} %".replace(".", ",")


def day_of(iso: str | None) -> dt.date | None:
    try:
        return dt.datetime.fromisoformat(iso).astimezone().date() if iso else None
    except ValueError:
        return dt.date.fromisoformat(iso[:10]) if iso else None


def mood(trend: float | None, polarity: str | None) -> list[str]:
    t = trend or 0.0
    if t >= 0.03:
        return ["mocno w górę", "pos"]
    if t >= 0.01:
        return ["wiatr w plecy", "pos"]
    if t <= -0.03:
        return ["pod presją", "neg"]
    if t <= -0.01:
        return ["słabnie", "neg"]
    if polarity == "negative":
        return ["niepewnie", "warn"]
    return ["spokojnie", "calm"]


def first_sentence(text: str | None, limit: int = 220) -> str:
    if not text:
        return ""
    m = re.match(r"(.+?[.!?])(\s|$)", text.strip())
    out = m.group(1) if m else text.strip()
    return out if len(out) <= limit else out[:limit].rsplit(" ", 1)[0] + "…"


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    arg = lambda name: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None
    template = os.path.join(root, "scripts", "prototypes", "research_story.html")
    out = arg("--out") or os.path.join(root, "build", "prototypes", "research-twoje-dane.html")
    want = arg("--profile")
    proc, port, token = start()
    base = f"http://127.0.0.1:{port}"

    def get(path: str):
        req = urllib.request.Request(base + path, headers={"X-Cashu-Token": token, "X-Cashu-Lang": "pl", "Host": f"127.0.0.1:{port}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)

    try:
        profiles = get("/api/profiles")
        slugs = [p["slug"] for p in profiles]
        slug = want if want in slugs else ("jakob" if "jakob" in slugs else slugs[0])
        inv = f"/api/p/{slug}/investments"
        today = dt.date.today()
        seg = get(f"{inv}/research/segments?window=1w")
        macro = get(f"{inv}/research/macro")
        notes = get(f"{inv}/research?since={(today - dt.timedelta(days=7)).isoformat()}&limit=500")
        summary = get(f"{inv}/research/summary")
        cands = get(f"{inv}/research?kind=candidate")
        try:
            cal = get(f"{inv}/calendar?days=14")
        except Exception:  # noqa: BLE001 - an app without the calendar endpoint
            cal = {"events": []}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()

    # ---- notes (third level keeps the full title, summary and source) ----
    N: dict[int, dict] = {}
    no_human = 0
    for n in notes:
        if n.get("dismissed_at") or n.get("kind") == "candidate":
            continue
        brief = (n.get("details") or {}).get("brief") or {}
        human = brief.get("headline")
        no_human += not human
        d = day_of(n.get("observed_at"))
        age = (today - d).days if d else 9
        inst = n.get("instrument") or {}
        src = (n.get("sources") or [{}])[0]
        N[n["id"]] = {
            "id": f"r{n['id']}", "h": human or n["title"], "t": n["title"] if human else "",
            "rel": REL.get(n.get("thesis_relation")), "who": inst.get("name") or inst.get("label") or n.get("segment_label") or "rynek",
            "kind": KIND.get(n.get("kind"), n.get("kind")), "day": 0 if age <= 0 else 1 if age == 1 else 2,
            "s": [p for p in re.split(r"\n{2,}", n.get("summary") or "") if p.strip()],
            "src": " · ".join(x for x in (src.get("publisher"), src.get("title"), (src.get("published_at") or "")[:10]) if x),
            "_inst": n.get("instrument_id"), "_seg": n.get("segment"), "_strength": n.get("strength") or 1,
        }

    # ---- macro ----
    MACRO, supports_risks = [], 0
    lead = None
    for r in macro.get("regimes", []):
        b = r.get("brief") or {}
        supports_risks += len(b.get("supports") or []) + len(b.get("risks") or [])
        since = day_of(r.get("since"))
        MACRO.append({
            "k": r["label"], "s": r.get("state_label") or r.get("state"), "m": TONE.get(r.get("tone"), "calm"),
            "nw": bool(since and (today - since).days <= 7),
            "x": f"<b>{b['headline']}.</b> {b.get('why') or ''}" if b.get("headline") else (r.get("summary") or r.get("plain") or ""),
        })
        if r.get("key") == "risk":
            lead = b.get("headline") or r.get("summary")

    # ---- topics ----
    TOPICS, QUIET, drafts = [], [], 0
    rows = sorted(seg.get("segments", []), key=lambda s: -abs(s.get("contribution") or 0))
    for s in rows:
        briefs = s.get("briefs") or []
        th = s.get("thesis") or {}
        ids = {i["instrument_id"] for i in s.get("instruments", [])} | {m["instrument_id"] for m in s.get("member_instruments") or []}
        own = sorted((n for n in N.values() if n["_seg"] == s["segment"] or n["_inst"] in ids), key=lambda n: (n["day"], -n["_strength"]))[:3]
        hl = briefs[0]["headline"] if briefs else (own[0]["h"] if own else None)
        if not hl:
            QUIET.append(s["label"])
            continue
        drafts += bool(th.get("draft"))
        labels = [m.get("label") for m in (s.get("member_instruments") or []) if m.get("label")] or [i.get("label") for i in s.get("instruments", []) if i.get("label")]
        TOPICS.append({
            "id": s["segment"], "nm": s["label"], "mood": mood(s.get("trend_1w"), briefs[0].get("polarity") if briefs else None),
            "imp": pp(s.get("contribution")) if s.get("weight") else "obserwowany", "hl": hl,
            "now": first_sentence(th.get("assessment")), "out": first_sentence(th.get("outlook")),
            "tick": " · ".join(labels[:8]), "draft": bool(th.get("draft")), "notes": [n["id"] for n in own],
        })

    # ---- my positions ----
    MINE = []
    soon = {}
    for e in cal.get("events", []):
        if e.get("kind") == "earnings" and e.get("instrument_id") is not None:
            d = dt.date.fromisoformat(e["date"])
            soon.setdefault(e["instrument_id"], f"wyniki {WEEKDAY[d.weekday()]} {d:%d.%m}")
    for i in summary.get("instruments", []):
        if not i.get("held"):
            continue
        inst = i.get("instrument") or {}
        latest = i.get("latest_note") or {}
        nid = latest.get("id")
        MINE.append({
            "nm": inst.get("name") or i.get("label") or inst.get("label") or "?", "sym": inst.get("symbol") or i.get("symbol") or "",
            "hl": HEALTH.get(i.get("health"), ["bez zmian", "calm"]), "line": (N[nid]["h"] if nid in N else latest.get("title")) or "Nic nowego w tym tygodniu",
            "soon": soon.get(i["instrument_id"]), "n": N[nid]["id"] if nid in N else None,
        })
    MINE.sort(key=lambda m: {"neg": 0, "pos": 1}.get(m["hl"][1], 2))

    # ---- calendar: the next 7 days ----
    AHEAD = []
    for e in cal.get("events", []):
        d = dt.date.fromisoformat(e["date"])
        if (d - today).days > 7:
            continue
        mine = e.get("held") is True
        title = re.sub(r"^Wyniki kwartalne (.+)$", r"\1 podaje wyniki", e["title"])
        AHEAD.append({"_d": e["date"], "d": WEEKDAY[d.weekday()], "day": f"{d:%d.%m}", "t": title, "r": "" if e.get("instrument_id") else (e.get("country_label") or ""),
                      "mine": mine, "w": e.get("time") if e.get("kind") == "earnings" else None})
    mine_ev = [e for e in AHEAD if e["mine"]]
    other = [e for e in AHEAD if not e["mine"]]
    AHEAD = sorted(mine_ev + other[: max(0, 8 - len(mine_ev))], key=lambda e: e["_d"])

    CANDS = []
    for n in cands:
        if n.get("dismissed_at") or (n.get("candidate") or {}).get("accepted_at") or n.get("expired"):
            continue
        c = n.get("candidate") or {}
        CANDS.append({"h": c.get("name") or c.get("symbol") or n["title"], "why": n["title"]})

    run = summary.get("last_run") or {}
    rd = day_of(run.get("started_at"))
    date = f"{WEEKDAY_LONG[rd.weekday()]} {rd:%d.%m}" if rd else "ostatni research"
    held = sum(1 for i in summary.get("instruments", []) if i.get("held"))
    top = [t["nm"] for t in TOPICS[:2]]
    story = f"Ostatni research ({date}) przejrzał {held} Twoich pozycji i {len(rows)} tematów." + (f" Najwięcej ruchu: {' i '.join(top)}." if top else "")
    total = (summary.get("totals") or {}).get("notes_active") or len(N)
    shown_home = sum(len(t["notes"]) for t in TOPICS)
    LOST = [
        f"{supports_risks} punktów „wspiera / uważaj” w makro (po kliknięciu znacznika)",
        f"{max(0, len(N) - shown_home)} z {len(N)} notatek z tego tygodnia (strona Wszystko)",
        f"{no_human} notatek nie ma jeszcze zdania po ludzku (pokazany tytuł z liczbami)",
        "liczby, streszczenia i źródła (panel notatki)",
    ]
    data = {
        "MACRO": MACRO, "AHEAD": AHEAD, "TOPICS": TOPICS, "QUIET": QUIET, "MINE": MINE, "CANDS": CANDS, "LOST": LOST,
        "META": {"date": date, "total": total, "lead": lead or "Rynek bez zmian.", "story": story,
                 "next": "następny research: według Twojej rutyny w Claude Code"},
        "NOTES": [{k: v for k, v in n.items() if not k.startswith("_")} for n in N.values()],
    }
    block = (
        "// ---- data: the owner's own cashU (rendered locally by render_real.py; never published) ----\n"
        f"const D = {json.dumps(data, ensure_ascii=False)};\n"
        "const N = {}; for (const n of D.NOTES) N[n.id] = n;\n"
        "const MACRO = D.MACRO, AHEAD = D.AHEAD, QUIET = D.QUIET, MINE = D.MINE, CANDS = D.CANDS, META = D.META, LOST = D.LOST;\n"
        "const TOPICS = D.TOPICS.map((t) => ({ ...t, notes: t.notes.map((id) => N[id]).filter(Boolean) }));\n"
    )
    with open(template, encoding="utf-8") as f:
        html = f.read()
    a = html.index("// ---- data:")
    b = html.index("// ---- rendering")
    html = html[:a] + block + html[b:]
    html = html.replace("<title>Research jako opowieść</title>", "<title>Research: Twoje dane</title>")
    html = html.replace("<span><b>Prototyp</b> · dane przykładowe, wymyślone spółki</span>", "<span><b>Prototyp</b> · Twoje dane z cashU, plik lokalny</span>")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(out)


if __name__ == "__main__":
    main()
