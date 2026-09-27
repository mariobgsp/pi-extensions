"""nodriver_engine.py — NodriverEngine STUB (not implemented).

Structured so a future worker can fill it in without touching the TS
client or daemon core: implement the same method set as
PlaywrightEngine (launch/navigate/snapshot/inspect/fill/click/check/
screenshot/wait/wait_for_login/close) and this module drops in via the
daemon's engine registry.

Selecting ``engine: "nodriver"`` today raises a clear error telling the
operator to ``pip install nodriver`` — and that the engine itself is
still a stub even once installed.
"""

NOT_IMPLEMENTED_MSG = (
    "engine 'nodriver' is not implemented yet (stub). "
    "Contribute NodriverEngine in engines/nodriver_engine.py. "
    "When implemented it will need: pip install nodriver"
)


class NodriverEngine:
    """Placeholder — every method raises NotImplementedError."""

    def __init__(self):
        raise NotImplementedError(NOT_IMPLEMENTED_MSG)

    def __getattr__(self, _name):
        raise NotImplementedError(NOT_IMPLEMENTED_MSG)
