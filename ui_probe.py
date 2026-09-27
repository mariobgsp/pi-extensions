#!/usr/bin/env python3
"""ui_probe.py — bounded, non-destructive Playwright UI probe for crew_verify.

Contract (see VERIFY.md):
  * Exactly ONE JSON object on stdout. Diagnostics/tracebacks go to stderr.
  * Exit 0 whenever JSON was printed; a bad spec still prints a JSON verdict.
  * Never starts a server, never opens a profile under ~/.cache/pi-browser,
    always closes its browser, respects a global deadline.

Run: python3.14 ui_probe.py --spec <abs path to <project>/.pi/verify/probe-spec.json>
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import socket
import sys
import time
import traceback
from urllib.parse import urlparse

CANDIDATES = (
    "a[href],button,[role=button],[role=tab],[role=menuitem],input[type=submit]"
)
# Click-sweep vocabulary. Destructive intent is read from the control's *label* (innerText +
# aria-label/title) and from its own inline handler/action attributes — never from raw HTML,
# hrefs or class names, which made benign controls look destructive ("Payments" matched
# "pay", class="reset-default-view" matched "reset") and skipped 4 of 8 controls on a benign
# page. Word boundaries, so "Payments" is not "pay".
DESTRUCTIVE_LABEL = re.compile(
    r"\b(?:delete|remove|archive|trash|sign out|signout|log out|logout|pay|buy|checkout|"
    r"purchase|unsubscribe|revoke|transfer|suspend|deactivate|abort|wipe|purge|destroy|"
    r"cancel account|cancel order|close account)\b"
    r"|\bclear\s+(?:all|data|everything|history|cart|log)\b",
    re.I,
)
# A dead click on a control that is legitimately inert in most states is a note, not a
# failure: "Cancel"/"Close"/"OK" with no dialog open must not FAIL a healthy route (W4).
INERT_LABEL = re.compile(r"\b(?:cancel|close|ok|apply|deselect|refresh|dismiss)\b", re.I)
# Inline handlers that write. The verb may sit in a method: option or in the call itself:
# fetch('/x',{method:'POST'}), axios.post, xhr.open('DELETE',…), navigator.sendBeacon(…).
# A verb in the *URL alone* is deliberately NOT a write (B2): a benign GET to
# '/api/soft-delete/preview' must still be clicked.
WRITE_HANDLER = re.compile(
    r"\b(?:fetch|open|axios)\b[^\"']{0,200}?(?:method\s*[:=]\s*)?[\"']?(post|put|patch|delete)\b"
    r"|\b\w+\s*\.\s*(post|put|patch|delete)\b"
    r"|\bmethod\s*[:=]\s*[\"'](post|put|patch|delete)[\"']"
    r"|(?:\b\w+\s*\.\s*)?submit\s*\("
    r"|\bsendBeacon\s*\(",
    re.I,
)
HANDLER_ATTR = re.compile(
    r"\b(on[a-z]+|hx-post|hx-put|hx-patch|hx-delete|formaction|formmethod|action)\s*=\s*"
    r"(?:\"([^\"]{0,1000})\"|'([^']{0,1000})'|([^\s>]{0,1000}))",
    re.I,
)
HTMX_WRITE = ("hx-post", "hx-put", "hx-patch", "hx-delete")
# Visible/accessible label only (innerText + aria-label/title).
LABEL_JS = """e => {
 const t = (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim();
 const aria = e.getAttribute('aria-label') || e.getAttribute('title') || '';
 return [t, aria].filter(Boolean).join(' ').slice(0, 80);
}"""
BAD_HREF = ("mailto:", "tel:", "javascript:")

# Internal viewport width; kept in sync with the spec's viewport width.
VIEWPORT_FALLBACK = {"width": 1280, "height": 800}

DOM_JS = """() => {
 const de = document.documentElement;
 const broken = [];
 for (const img of document.images) {
  try { if (img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)) broken.push(img.currentSrc || img.src); } catch (e) {}
 }
 return {
  brokenImages: broken.slice(0, 20),
  overflowX: de.scrollWidth - de.clientWidth,
  text: (document.body ? document.body.innerText : "").slice(0, 20000),
  title: document.title,
  elementCount: document.querySelectorAll("body *").length,
  // Real content with no text at all (a canvas chart, a poster image) is not an
  // "empty document": media presence clears the rule (B4).
  mediaCount: document.querySelectorAll("canvas,svg,img,video,iframe").length,
  scrollHeight: de.scrollHeight,
 };
}"""

MUT_JS = """() => {
 window.__uiProbeMutations = 0;
 try {
  const o = new MutationObserver((recs) => { window.__uiProbeMutations += recs.length; });
  o.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
  window.__uiProbeObserver = o;
 } catch (e) {}
 return true;
}"""


def emit(obj) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def destructive_reason(label: str, attrs: str) -> str | None:
    """Why this control looks like a write, or None.

    Static only. Label first, then the inline handler / action ATTRIBUTES of the element itself
    and of its ancestor chain (up to 4 levels), so a form-level `onsubmit` write or an ancestor
    `div[hx-post]` is seen even when the button's own label is innocuous.

    A URL is never destructive by itself — only a *write* is: a `method:'POST'`-style call, an
    htmx write verb, `sendBeacon(` or a non-GET form method. `fetch('/api/soft-delete/preview')`
    is a GET and is clicked (B2); the destructive-verb check applies to the label only.

    Ceiling (documented in VERIFY.md): a listener attached with addEventListener inside
    minified JS is invisible here, and a control with no label and no readable handler is
    protected only by the POST-form rule.
    """
    if DESTRUCTIVE_LABEL.search(label or ""):
        return "destructive label"
    for m in HANDLER_ATTR.finditer(attrs or ""):
        attr = m.group(1).lower()
        value = m.group(2) or m.group(3) or m.group(4) or ""
        if attr in HTMX_WRITE:
            return f"{attr} is a write"
        if attr == "formmethod":
            # A submit control's own formmethod OVERRIDES the owning form's method, so the
            # non-GET form rule below never sees it (R4-2a: the click really POSTed).
            if value.strip().lower() not in ("", "get"):
                return f"formmethod={value.strip().lower()} is a write"
            continue
        if WRITE_HANDLER.search(value):
            return f"{attr} writes (POST/PUT/PATCH/DELETE)"
    return None

def slug(route_path: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", str(route_path))
    return s.strip("-") or "root"


def join_route(base: str, route: str) -> str:
    return base.rstrip("/") + "/" + str(route).lstrip("/")


def same_origin(a: str, b: str) -> bool:
    try:
        return urlparse(a).netloc == urlparse(b).netloc
    except Exception:
        return False


def rel_path(path: str, project_root: str | None) -> str:
    if project_root:
        try:
            return os.path.relpath(path, project_root)
        except ValueError:
            pass
    return os.path.basename(path)


def deadline_hit(deadline_ms: float) -> bool:
    return time.time() * 1000 >= deadline_ms


def take_shot(page, path: str, scroll_height: int, width: int) -> bool:
    """One screenshot. ponytail: naive tall-page cap at 3000px; raise if detail is lost."""
    try:
        if scroll_height and scroll_height > 3000:
            page.screenshot(
                path=path,
                animations="disabled",
                caret="hide",
                clip={"x": 0, "y": 0, "width": width, "height": 3000},
            )
        else:
            page.screenshot(
                path=path, full_page=True, animations="disabled", caret="hide"
            )
        return True
    except Exception:
        traceback.print_exc()
        return False


def probe_route(page, ctx, spec, route, state, deadline_ms, shots_dir, project_root):
    """Probe one route; returns the page entry and the shot paths it produced."""
    nav_timeout = int(spec.get("navTimeoutMs") or 15000)
    action_timeout = int(spec.get("actionTimeoutMs") or 5000)
    width = int((spec.get("viewport") or VIEWPORT_FALLBACK).get("width") or 1280)
    budget = int(spec.get("clickBudget") or 0)
    ignores = [str(i).lower() for i in (spec.get("ignoreConsole") or [])]
    url = join_route(str(spec.get("url") or ""), route)

    ev = {
        "pageerror": [], "console": [], "requestfailed": [], "http": [],
        "dialogs": [], "crashed": False,
    }
    entry = {
        "route": route,
        "status": "PASS",
        "httpStatus": None,
        "title": None,
        "loadError": None,
        "pageErrors": [],
        "consoleErrors": [],
        "consoleWarnings": [],
        "requestFailed": [],
        "crossOriginFailures": [],
        "httpErrors": [],
        "brokenImages": [],
        "missingText": [],
        "missingSelectors": [],
        "overflowX": 0,
        "clicks": [],
        "destructiveSkips": 0,
        "inertClicks": 0,
        "screenshot": None,
        "ariaSnapshot": "",
    }
    shots: list[str] = []

    # Collectors are wired BEFORE navigation so nothing is missed.
    page.on("pageerror", lambda e: ev["pageerror"].append(str(e)[:300]))
    page.on(
        "console",
        lambda m: ev["console"].append(
            {"type": str(getattr(m, "type", "log")), "text": str(getattr(m, "text", ""))[:300]}
        ),
    )
    page.on(
        "requestfailed",
        lambda r: ev["requestfailed"].append(
            [str(r.url), str(getattr(r, "failure", "") or "")[:200]]
        ),
    )
    page.on(
        "response",
        lambda r: ev["http"].append([int(r.status), str(r.url)]) if r.status >= 400 else None,
    )
    page.on(
        "dialog",
        # A dialog that is never handled freezes the page; always dismiss.
        lambda d: (ev["dialogs"].append(str(getattr(d, "type", "dialog"))), d.dismiss()),
    )
    page.on("crash", lambda _p: ev.update({"crashed": True}))

    resp = None
    try:
        resp = page.goto(url, wait_until="load", timeout=nav_timeout)
    except Exception as e:
        entry["loadError"] = str(e)[:300]
    if resp is not None:
        try:
            entry["httpStatus"] = int(resp.status)
        except Exception:
            entry["httpStatus"] = None
    try:
        page.wait_for_load_state("networkidle", timeout=min(4000, nav_timeout))
    except Exception as e:
        # HMR/SSE dev servers may never reach networkidle — non-fatal, but never silent.
        print(f"networkidle wait skipped: {str(e)[:120]}", file=sys.stderr)

    dom = {}
    try:
        dom = page.evaluate(DOM_JS) or {}
    except Exception as e:
        entry["consoleWarnings"].append(f"dom check failed: {str(e)[:200]}")
    entry["title"] = dom.get("title")
    entry["overflowX"] = int(dom.get("overflowX") or 0)
    entry["brokenImages"] = list(dom.get("brokenImages") or [])[:20]
    body_text = str(dom.get("text") or "")

    # Written expectations from .pi/verify.json.
    for want in (spec.get("expectedText") or {}).get(route, []) or []:
        if want and str(want) not in body_text:
            entry["missingText"].append(str(want))
    for sel in (spec.get("expectSelectors") or {}).get(route, []) or []:
        try:
            if page.locator(str(sel)).count() == 0:
                entry["missingSelectors"].append(str(sel))
        except Exception:
            entry["missingSelectors"].append(f"{sel} (invalid selector)")

    # --- bounded, non-destructive click sweep
    # Config escape (see VERIFY.md): ui.clickSkipRoutes disables the sweep for a route,
    # ui.clickAllow force-clicks a label that looks destructive anyway.
    sweep_ok = route not in {str(r) for r in (spec.get("clickSkipRoutes") or [])}
    allow = {str(a).strip().lower() for a in (spec.get("clickAllow") or [])}
    clicks_seen = 0
    loc = page.locator(CANDIDATES)
    try:
        total = loc.count()
    except Exception:
        total = 0
    for i in range(min(total, 40)):
        if not sweep_ok or clicks_seen >= budget:
            break
        if deadline_hit(deadline_ms):
            state["deadlineExceeded"] = True
            break
        el = loc.nth(i)
        html = ""
        label = ""
        read_ok = True
        try:
            html = str(el.evaluate("e => e.outerHTML.slice(0, 800)") or "")
            label = str(el.evaluate(LABEL_JS) or "").strip()[:80]
        except Exception as e:
            read_ok = False
            print(f"candidate {i} unreadable: {str(e)[:120]}", file=sys.stderr)
        if not read_ok:
            continue
        shown = label or re.sub(r"\s+", " ", html)[:60]
        # Attributes of the control AND its ancestor chain (element first, up to 4 levels).
        # A form-level `onsubmit` write or an ancestor `div[hx-post]` fires when this button is
        # clicked, so an innocuous "Save note" label is no protection (B2).
        attrs = html
        with contextlib.suppress(Exception):
            attrs = (
                str(
                    el.evaluate(
                        "e => { const out = []; let n = e; while (n && n.nodeType === 1 && out.length < 4)"
                        " { out.push(Array.from(n.attributes || []).map(a => a.name + '=\"' + a.value + '\"').join(' '));"
                        " n = n.parentElement; } return out.join(' '); }"
                    )
                    or ""
                )
                or html
            )
        # A click on a submit inside a non-GET form is a write whatever the label says
        # ("Confirm" inside <form action="/purge" method="post">). Unreadable form
        # membership fails closed: a non-destructive sweep must not guess.
        form = None
        form_read_ok = True
        try:
            form = el.evaluate(
                "e => { let f = e.closest('form');"
                " if (!f) { const id = e.getAttribute('form'); const byId = id ? document.getElementById(id) : null;"
                " f = byId && byId.tagName === 'FORM' ? byId : null; }"
                " return f ? {"
                "method: (f.getAttribute('method') || 'get').toLowerCase(),"
                "action: f.getAttribute('action') || '',"
                "attrs: Array.from(f.attributes || []).map(a => a.name + '=\"' + a.value + '\"').join(' ')} : null; }"
            )
        except Exception as e:
            form_read_ok = False
            print(f"form membership unreadable: {str(e)[:120]}", file=sys.stderr)
        if not form_read_ok:
            entry["clicks"].append(
                {"target": shown, "result": "skipped", "detail": "form membership unreadable"}
            )
            entry["destructiveSkips"] += 1
            continue
        reason = destructive_reason(
            label or html, f"{attrs} {str((form or {}).get('attrs') or '')}"
        )
        if reason and label.strip().lower() not in allow:
            entry["clicks"].append(
                {"target": shown, "result": "skipped", "detail": f"destructive-looking ({reason})"}
            )
            entry["destructiveSkips"] += 1
            continue
        if form is not None and str(form.get("method") or "get").lower() != "get":
            entry["clicks"].append(
                {
                    "target": shown,
                    "result": "skipped",
                    "detail": f"destructive form ({form.get('method')} {form.get('action')})",
                }
            )
            entry["destructiveSkips"] += 1
            continue
        href = ""
        with contextlib.suppress(Exception):
            href = str(el.get_attribute("href") or "")
        if href.lower().startswith(BAD_HREF) or href.startswith("#"):
            continue
        if 'target="_blank"' in html.lower():
            continue
        disabled = False
        with contextlib.suppress(Exception):
            disabled = el.get_attribute("disabled") is not None
        if disabled:
            continue
        box = None
        with contextlib.suppress(Exception):
            box = el.bounding_box()
        if not box or not box.get("width") or not box.get("height"):
            continue  # off-viewport / zero-size: not actionable, not evidence
        clicks_seen += 1
        try:
            el.click(trial=True, timeout=action_timeout)
        except Exception as e:
            entry["clicks"].append(
                {"target": shown, "result": "not-actionable", "detail": str(e)[:200]}
            )
            continue
        before_url = page.url
        errors_before = len(ev["pageerror"])
        popups_before = state["popups"]
        with contextlib.suppress(Exception):
            page.evaluate(MUT_JS)
        try:
            el.click(timeout=action_timeout)
        except Exception as e:
            entry["clicks"].append(
                {"target": shown, "result": "error", "detail": str(e)[:200]}
            )
            continue
        page.wait_for_timeout(500)
        try:
            mutated = int(page.evaluate("() => window.__uiProbeMutations || 0") or 0)
        except Exception:
            mutated = 0
        new_errors = ev["pageerror"][errors_before:]
        if new_errors:
            entry["clicks"].append(
                {"target": shown, "result": "error", "detail": str(new_errors[0])[:200]}
            )
        elif page.url != before_url or mutated > 0 or state["popups"] > popups_before:
            entry["clicks"].append(
                {
                    "target": shown,
                    "result": "changed",
                    "detail": f"url/mutations={mutated}",
                }
            )
            if len(shots) < int(spec.get("shotsPerRoute") or 3):
                p = os.path.join(shots_dir, f"{slug(route)}-click-{clicks_seen}.png")
                if take_shot(page, p, int(dom.get("scrollHeight") or 0), width):
                    shots.append(p)
        else:
            if INERT_LABEL.search(label or ""):
                # Legitimately inert in one state ("Cancel" with no dialog open) is not a
                # broken page: the click is recorded as a note, never a fail signal (W4).
                entry["clicks"].append(
                    {
                        "target": shown,
                        "result": "inert",
                        "detail": "url unchanged, 0 mutations; label is inert in most states",
                    }
                )
                entry["inertClicks"] += 1
            else:
                entry["clicks"].append(
                    {
                        "target": shown,
                        "result": "dead-click",
                        "detail": "url unchanged, 0 mutations, no dialog, no popup",
                    }
                )
        # Restore state by re-navigating (history.pushState makes go_back unreliable).
        with contextlib.suppress(Exception):
            page.goto(url, wait_until="load", timeout=nav_timeout)

    # --- evidence: aria snapshot + screenshots after the sweep
    try:
        entry["ariaSnapshot"] = str(page.aria_snapshot())[:4000]
    except Exception as e:
        entry["consoleWarnings"].append(f"aria_snapshot failed: {str(e)[:200]}")

    clean = os.path.join(shots_dir, f"{slug(route)}.png")
    if take_shot(page, clean, int(dom.get("scrollHeight") or 0), width):
        shots.append(clean)
        entry["screenshot"] = rel_path(clean, project_root)

    # --- fold collectors into the entry
    entry["pageErrors"] = [str(e) for e in ev["pageerror"]][:20]
    entry["consoleErrors"] = [
        m["text"]
        for m in ev["console"]
        if m["type"] == "error" and not any(i and i in m["text"].lower() for i in ignores)
    ][:20]
    entry["consoleWarnings"] = entry["consoleWarnings"] + [
        m["text"]
        for m in ev["console"]
        if m["type"] == "warning" and not any(i and i in m["text"].lower() for i in ignores)
    ][:10]
    entry["requestFailed"] = [
        r for r in ev["requestfailed"] if same_origin(r[0], url)
    ][:20]
    # A frontend on :3000 with a dead backend on :8000 leaves no other signal, so
    # cross-origin failures are kept (at least WARN) instead of being filtered away.
    # Navigation aborts are not failures: net::ERR_ABORTED is ignored.
    entry["crossOriginFailures"] = [
        r
        for r in ev["requestfailed"]
        if not same_origin(r[0], url)
        and urlparse(r[0]).scheme.lower() in ("http", "https")
        and "ERR_ABORTED" not in str(r[1])
    ][:20]
    entry["httpErrors"] = [
        h for h in ev["http"] if same_origin(h[1], url) and h[0] >= 400
    ][:20]

    fails: list[str] = []
    if entry["loadError"]:
        fails.append("load")
    if entry["httpStatus"] is not None and entry["httpStatus"] >= 400:
        fails.append("document status")
    # A 200 that renders nothing is not "clean": an unmounted root div and a blank body both
    # logged no error and read as success before this check (W2). Narrowed (B4): a 200 is only
    # "empty" when there is no visible text AND no media content — a canvas chart page or an
    # image-only poster page has no text but is not empty, so it PASSes.
    if (
        entry["httpStatus"] == 200
        and not body_text.strip()
        and int(dom.get("elementCount") or 0) < 5
        and int(dom.get("mediaCount") or 0) == 0
    ):
        fails.append("empty document")
    if entry["pageErrors"]:
        fails.append("pageerror")
    if entry["httpErrors"]:
        fails.append("http error")
    if entry["requestFailed"]:
        fails.append("failed request")
    if ev["crashed"]:
        fails.append("crash")
    if entry["brokenImages"]:
        fails.append("broken image")
    if entry["missingText"]:
        fails.append("missing text")
    if entry["missingSelectors"]:
        fails.append("missing selector")
    if any(c["result"] in ("dead-click", "error") for c in entry["clicks"]):
        fails.append("click")
    entry["status"] = "FAIL" if fails else "PASS"
    entry["failSignals"] = fails
    # No "-error.png" artifact: the sweep already re-navigated to this route, so such a
    # shot would be byte-identical to the clean one and would lie about what it shows.
    return entry, shots


def preflight(url: str) -> str | None:
    """Return a SKIP reason when nothing is listening for the target URL.

    A plain TCP connect (not an HTTP fetch) keeps "app not running" distinct from
    "page threw", and only http/https hosts are ever dialled.
    """
    parts = urlparse(url)
    if parts.scheme.lower() not in ("http", "https"):
        return f"unsupported url scheme '{parts.scheme}': {url}"
    host = parts.hostname
    if not host:
        return f"url has no host: {url}"
    port = parts.port or (443 if parts.scheme.lower() == "https" else 80)
    try:
        with socket.create_connection((host, port), timeout=5):
            return None
    except OSError as e:
        return f"unreachable: {url} ({str(e)[:200]})"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    args = ap.parse_args()

    started = time.time()
    result = {
        "status": "SKIP",
        "reason": None,
        "url": None,
        "durationMs": 0,
        "deadlineExceeded": False,
        "shotsDir": None,
        "artifacts": [],
        "pages": [],
    }
    try:
        with open(args.spec, encoding="utf-8") as fh:
            spec = json.load(fh)
    except Exception as e:
        result["reason"] = f"spec unreadable: {str(e)[:200]}"
        result["durationMs"] = int((time.time() - started) * 1000)
        emit(result)
        return 0

    url = str(spec.get("url") or "")
    project_root = spec.get("projectRoot")
    shots_dir = str(spec.get("shotsDir") or "")
    result["url"] = url
    result["shotsDir"] = rel_path(shots_dir, project_root) if shots_dir else None
    deadline_ms = started * 1000 + max(int(spec.get("deadlineMs") or 90000), 2000)

    try:
        if not url:
            result["reason"] = "spec has no url"
            result["durationMs"] = int((time.time() - started) * 1000)
            emit(result)
            return 0
        if shots_dir:
            os.makedirs(shots_dir, exist_ok=True)
        bad = preflight(url)
        if bad:
            result["reason"] = bad
            result["durationMs"] = int((time.time() - started) * 1000)
            emit(result)
            return 0
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            result["reason"] = f"playwright python not importable: {str(e)[:200]}"
            result["durationMs"] = int((time.time() - started) * 1000)
            emit(result)
            return 0

        state = {"popups": 0, "deadlineExceeded": False}
        routes = [str(r) for r in (spec.get("routes") or [])] or ["/"]
        with sync_playwright() as p:
            try:
                exe = p.chromium.executable_path
            except Exception as e:
                result["reason"] = f"chromium not installed: {str(e)[:200]}"
                result["durationMs"] = int((time.time() - started) * 1000)
                emit(result)
                return 0
            if not exe or not os.path.exists(exe):
                result["reason"] = f"chromium missing: {exe}"
                result["durationMs"] = int((time.time() - started) * 1000)
                emit(result)
                return 0
            browser = None
            try:
                browser = p.chromium.launch(headless=True)
                ctx = browser.new_context(
                    viewport={
                    "width": int((spec.get("viewport") or VIEWPORT_FALLBACK).get("width") or 1280),
                    "height": int((spec.get("viewport") or VIEWPORT_FALLBACK).get("height") or 800),
                },
                    device_scale_factor=1,
                    ignore_https_errors=True,
                )
                ctx.set_default_timeout(int(spec.get("actionTimeoutMs") or 5000))
                ctx.on("page", lambda _p: state.update({"popups": state["popups"] + 1}))
                for route in routes:
                    # Do not start a route that cannot finish before the deadline: the probe
                    # must still have room to close the browser and print its verdict.
                    if deadline_hit(deadline_ms) or (deadline_ms - time.time() * 1000) < 1500:
                        state["deadlineExceeded"] = True
                        break
                    page = ctx.new_page()
                    try:
                        entry, shots = probe_route(
                            page, ctx, spec, route, state, deadline_ms, shots_dir, project_root
                        )
                    except Exception:
                        traceback.print_exc()
                        entry = {
                            "route": route,
                            "status": "FAIL",
                            "httpStatus": None,
                            "title": None,
                            "loadError": "probe exception",
                            "pageErrors": [traceback.format_exc(limit=2)[-200:]],
                            "consoleErrors": [],
                            "consoleWarnings": [],
                            "requestFailed": [],
                            "crossOriginFailures": [],
                            "httpErrors": [],
                            "brokenImages": [],
                            "missingText": [],
                            "missingSelectors": [],
                            "overflowX": 0,
                            "clicks": [],
                            "destructiveSkips": 0,
                            "screenshot": None,
                            "ariaSnapshot": "",
                        }
                        shots = []
                    finally:
                        with contextlib.suppress(Exception):
                            page.close()
                    if shots:
                        for s in shots:
                            if rel_path(s, project_root) not in result["artifacts"]:
                                result["artifacts"].append(rel_path(s, project_root))
                    result["pages"].append(entry)
            finally:
                if browser is not None:
                    with contextlib.suppress(Exception):
                        browser.close()
        result["deadlineExceeded"] = bool(state["deadlineExceeded"])
        pages = result["pages"]
        # Every reason counts against the REQUESTED route count, never against the pages the
        # probe happened to reach: "1/1 routes failed" must read "1/25".
        if not pages:
            result["status"] = "SKIP"
            result["reason"] = f"no route was probed (0/{len(routes)})"
        elif any(p["status"] == "FAIL" for p in pages):
            result["status"] = "FAIL"
            result["reason"] = (
                f"{sum(1 for p in pages if p['status'] == 'FAIL')}/{len(routes)} routes failed"
                + (
                    f" — deadline: {len(pages)}/{len(routes)} routes probed"
                    if result["deadlineExceeded"]
                    else ""
                )
            )
        elif result["deadlineExceeded"]:
            # Pages collected before the clock ran out are not evidence for the routes
            # that were never visited: the probe cannot report PASS for them.
            result["status"] = "SKIP"
            result["reason"] = f"deadline: {len(pages)}/{len(routes)} routes probed"
        else:
            result["status"] = "PASS"
            result["reason"] = f"{len(pages)}/{len(routes)} routes clean"
    except Exception:
        traceback.print_exc()
        result["status"] = "SKIP"
        result["reason"] = "probe crashed: " + traceback.format_exc(limit=3).replace("\n", " | ")
    result["durationMs"] = int((time.time() - started) * 1000)
    result["artifacts"] = result["artifacts"][:50]
    emit(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
