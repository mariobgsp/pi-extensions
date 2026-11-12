"""playwright_engine.py — full PlaywrightEngine for the browser-auto daemon.

Owns one persistent browser context (user-data-dir
~/.cache/pi-browser/profile) + one page. Duck-typed against the daemon's
Engine interface: launch/navigate/snapshot/inspect/fill/click/check/
screenshot/wait/wait_for_login/close.

Stealth: real user-agent/viewport/locale, channel="chrome" preferred
(falls back to bundled Chromium), playwright-stealth sync API per page
via stealth.apply_stealth (soft no-op if the package is missing).
Patchright swap knob: replace the sync_playwright import with
``from patchright.sync_api import sync_playwright`` — API-compatible.
"""

import os
import time

PROFILE_DIR = os.path.expanduser("~/.cache/pi-browser/profile")
DEFAULT_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
DEFAULT_VIEWPORT = {"width": 1366, "height": 900}
DEFAULT_LOCALE = "en-US"

PLAYWRIGHT_HINT = (
    "playwright is not installed. Run: pip install playwright && python -m playwright install chrome"
)


class PlaywrightEngine:
    def __init__(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise RuntimeError(PLAYWRIGHT_HINT)
        self._pw_factory = sync_playwright
        self._pw = None
        self._ctx = None
        self._page = None
        self._nodes = {}  # ref -> snapshot node (from last snapshot())

    # -- lifecycle -----------------------------------------------------
    def launch(self, headless=True, proxy=None, profile=None, **_kw):
        self.close()
        try:
            from stealth import apply_stealth
        except ImportError:
            def apply_stealth(_p):
                return False
        self._pw = self._pw_factory().start()
        kwargs = {
            "user_data_dir": profile or PROFILE_DIR,
            "headless": headless,
            "viewport": DEFAULT_VIEWPORT,
            "locale": DEFAULT_LOCALE,
            "user_agent": DEFAULT_UA,
        }
        if proxy:
            kwargs["proxy"] = {"server": proxy} if isinstance(proxy, str) else proxy
        try:
            # Real Chrome Anti-detect preferred; userspace Chrome-for-Testing
            # next; bundled Chromium fallback.
            self._ctx = self._pw.chromium.launch_persistent_context(channel="chrome", **kwargs)
        except Exception:
            cft = os.path.expanduser("~/.cache/ms-playwright/chrome-linux64/chrome")
            try:
                if os.path.exists(cft):
                    kwargs["executable_path"] = cft
                self._ctx = self._pw.chromium.launch_persistent_context(**kwargs)
            finally:
                kwargs.pop("executable_path", None)
        pages = self._ctx.pages
        self._page = pages[0] if pages else self._ctx.new_page()
        apply_stealth(self._page)
        return {"ok": True, "url": self._page.url}

    def _require_page(self):
        if self._page is None:
            raise RuntimeError("browser not launched — call browser_launch first")
        return self._page

    def close(self):
        for attr in ("_ctx", "_pw"):
            obj = getattr(self, attr, None)
            if obj is not None:
                try:
                    obj.close() if attr == "_ctx" else obj.stop()
                except Exception:
                    pass
                setattr(self, attr, None)
        self._page = None
        self._nodes = {}
        return {"ok": True}

    # -- ops -----------------------------------------------------------
    def navigate(self, url):
        page = self._require_page()
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        return {"ok": True, "url": page.url}

    def snapshot(self):
        import sys
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from snapshot import normalise_tree
        page = self._require_page()
        try:
            tree = page.accessibility.snapshot()
        except Exception:
            tree = None
        nodes = normalise_tree(tree) if tree else self._dom_fallback(page)
        self._nodes = {n["ref"]: n for n in nodes}
        return {"ok": True, "url": page.url, "nodes": nodes}

    def _dom_fallback(self, page):
        try:
            items = page.evaluate(
                """() => Array.from(document.querySelectorAll(
                  'a,button,input,select,textarea,[role=button],[role=link]'))
                  .slice(0, 300).map(el => ({
                    role: el.tagName.toLowerCase(),
                    name: el.innerText?.slice(0,100) || el.value || el.placeholder || el.getAttribute('aria-label') || '',
                    text: el.value ?? '' }))"""
            )
        except Exception:
            return []
        return [
            {"ref": f"e{i+1}", "role": it.get("role", ""),
             "name": it.get("name", "") or "", "text": it.get("text", "") or ""}
            for i, it in enumerate(items)
        ]

    def inspect(self, ref):
        self._require_page()
        node = self._nodes.get(ref)
        if node is None:
            # Refresh once — refs go stale after navigation.
            self.snapshot()
            node = self._nodes.get(ref)
        if node is None:
            raise RuntimeError(f"unknown ref {ref!r} — take a fresh browser_snapshot")
        return {"ok": True, "node": node}

    _ROLE_MAP = {"a": "link", "link": "link", "button": "button",
                  "input": "textbox", "textarea": "textbox", "textbox": "textbox",
                  "searchbox": "searchbox", "checkbox": "checkbox",
                  "select": "combobox", "combobox": "combobox", "img": "img"}

    def _locator_for(self, ref):
        # ponytail: locate via ARIA role+name, not hand-built CSS strings.
        page = self._require_page()
        node = self._nodes.get(ref)
        if not node or not node.get("name"):
            return None
        aria = self._ROLE_MAP.get(node.get("role", ""))
        if aria:
            return page.get_by_role(aria, name=node["name"][:60])
        return page.get_by_text(node["name"][:60])

    def _selector_for(self, ref):
        # Legacy CSS-string path; prefer _locator_for for new code.
        node = self._nodes.get(ref)
        if node and node.get("name"):
            import re
            name = re.escape(node["name"][:60])
            return f"text=/{name}/i"
        return None

    def fill(self, ref, text, submit=False):
        page = self._require_page()
        loc = self._locator_for(ref)
        if loc is None:
            raise RuntimeError(f"unknown/unfillable ref {ref!r} — take a fresh browser_snapshot")
        try:
            loc.fill(text, timeout=5000)
        except Exception:
            # ponytail: role+name matching can miss (e.g. a11y name from
            # title/placeholder vs computed label); fall back to the first
            # visible text field rather than failing the whole flow.
            page.locator("textarea:visible, input[type=text]:visible, "
                         "input[type=search]:visible, input:not([type]):visible"
                         ).first.fill(text, timeout=5000)
        if submit:
            page.keyboard.press("Enter")
        return {"ok": True, "url": page.url}

    def click(self, ref):
        page = self._require_page()
        loc = self._locator_for(ref)
        if loc is None:
            raise RuntimeError(f"unknown/unclickable ref {ref!r} — take a fresh browser_snapshot")
        loc.click(timeout=10000)
        page.wait_for_load_state("domcontentloaded", timeout=15000)
        return {"ok": True, "url": page.url}

    def check(self, ref, checked=True):
        page = self._require_page()
        loc = self._locator_for(ref)
        if loc is None:
            raise RuntimeError(f"unknown/uncheckable ref {ref!r} — take a fresh browser_snapshot")
        loc.set_checked(checked, timeout=10000)
        return {"ok": True, "url": page.url}

    def screenshot(self, path=None):
        page = self._require_page()
        dest = path or os.path.expanduser("~/.cache/pi-browser/shot.png")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        page.screenshot(path=dest)
        return {"ok": True, "path": dest}

    def wait(self, text=None, url=None, selector=None, timeout=15000):
        page = self._require_page()
        if selector:
            page.wait_for_selector(selector, timeout=timeout)
        elif text:
            page.get_by_text(text).first.wait_for(timeout=timeout)
        elif url:
            page.wait_for_url(f"**{url}**", timeout=timeout)
        else:
            page.wait_for_load_state("networkidle", timeout=timeout)
        return {"ok": True, "url": page.url}

    def wait_for_login(self, timeout=180, url_contains=None, selector=None):
        """Blocking human handoff: detect-and-wait loop, never auto-solve captchas."""
        page = self._require_page()
        timeout = max(120, min(int(timeout or 180), 300))
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                cur = page.url
            except Exception:
                cur = ""
            if url_contains and url_contains in cur:
                return {"ok": True, "url": cur, "reason": "url-matched"}
            if selector:
                try:
                    if page.query_selector(selector):
                        return {"ok": True, "url": cur, "reason": "selector-present"}
                except Exception:
                    pass
            if not url_contains and not selector and cur and "login" not in cur.lower():
                return {"ok": True, "url": cur, "reason": "url-changed"}
            time.sleep(2)
        return {"ok": False, "url": page.url if self._page else "",
                "error": f"login wait timed out after {timeout}s — user did not complete login"}
