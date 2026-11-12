"""snapshot.py — normalise a Playwright accessibility tree into {ref, role, name, text} nodes.

Stdlib only. The daemon's PlaywrightEngine passes the raw
``page.accessibility.snapshot()`` dict through :func:`normalise_tree`;
the flat node list is what ``browser_snapshot`` returns to the model,
and the ``ref`` values are the handles ``browser_fill/click/check``
accept.
"""

_counter = 0


def _walk(node, out):
    global _counter
    if not isinstance(node, dict):
        return
    role = node.get("role", "")
    name = node.get("name", "") or ""
    value = node.get("value", "") or ""
    # Skip anonymous layout containers — they carry no actionable signal.
    if role not in ("generic", "none", "presentation") or name or value:
        _counter += 1
        out.append({
            "ref": f"e{_counter}",
            "role": role,
            "name": name,
            "text": value if isinstance(value, str) else str(value),
        })
    for child in node.get("children") or []:
        _walk(child, out)


def normalise_tree(tree):
    """Flatten a raw accessibility snapshot dict into a ref-tagged node list."""
    global _counter
    _counter = 0
    out = []
    if tree:
        _walk(tree, out)
    return out
