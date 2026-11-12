"""stealth.py — one-call stealth hardening for a Playwright page.

Uses the ``playwright-stealth`` sync API per page. Missing package is a
soft no-op returning False (daemon still works, just less stealthy).

Swap knob: to use Patchright instead, ``pip install patchright`` and
replace the ``sync_playwright`` import in engines/playwright_engine.py
with ``from patchright.sync_api import sync_playwright`` — no other
change needed (API-compatible). Then this module becomes redundant and
can return True immediately.
"""

_APPLIED_ATTR = "_pi_stealth_applied"


def apply_stealth(page):
    """Apply stealth evasions to an already-created page. Returns bool."""
    if getattr(page, _APPLIED_ATTR, False):
        return True
    try:
        from playwright_stealth import stealth_sync
    except ImportError:
        return False
    try:
        stealth_sync(page)
        setattr(page, _APPLIED_ATTR, True)
        return True
    except Exception:
        return False
