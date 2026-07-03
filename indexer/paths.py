"""Path/root resolution and key derivation for the fruitmail indexer.

Owns ``message_id_from_name`` (F0), account/mailbox inference with resolved
containment (behaviors 9-11) and the numeric V<N> mail-root pick (F8).
"""

from __future__ import annotations

import os
import pathlib
from typing import Optional


def resolve_mail_root() -> pathlib.Path:
    """``FRUITMAIL_MAIL_ROOT`` env override, else highest ``~/Library/Mail/V<N>``.

    The V<N> pick compares N numerically (``int(name[1:])``), so V10 > V9 (F8).
    """
    override = os.environ.get("FRUITMAIL_MAIL_ROOT")
    if override:
        return pathlib.Path(override)
    mail_dir = pathlib.Path.home() / "Library" / "Mail"
    best: Optional[pathlib.Path] = None
    best_n = -1
    if mail_dir.is_dir():
        for child in mail_dir.iterdir():
            if not child.is_dir() or not child.name.startswith("V"):
                continue
            try:
                n = int(child.name[1:])
            except ValueError:
                continue
            if n > best_n:
                best_n = n
                best = child
    if best is None:
        raise FileNotFoundError(f"no Apple Mail V<N> root found under {mail_dir}")
    return best


def _resolve_env_or_default(env_key: str, default_path: pathlib.Path) -> pathlib.Path:
    """Return the env-var override if set, else ``default_path``."""
    override = os.environ.get(env_key)
    return pathlib.Path(override) if override else default_path


def resolve_index_db() -> pathlib.Path:
    """``FRUITMAIL_INDEX_DB`` env override, else ``~/.fruitmail/index.db``."""
    return _resolve_env_or_default("FRUITMAIL_INDEX_DB", pathlib.Path.home() / ".fruitmail" / "index.db")


def resolve_state_db() -> pathlib.Path:
    """``FRUITMAIL_STATE_DB`` env override, else ``~/.fruitmail/cocoindex-state.db``."""
    return _resolve_env_or_default(
        "FRUITMAIL_STATE_DB", pathlib.Path.home() / ".fruitmail" / "cocoindex-state.db"
    )


def infer_account_mailbox(
    path: pathlib.Path, root: pathlib.Path
) -> tuple[Optional[str], str]:
    """Derive ``(account, mailbox)`` from an .emlx path under the mail root.

    Containment compares the file and the root in the SAME resolved form
    (never str.startswith), so ``..`` traversal cannot misattribute
    (behavior 10). account is the first path component; mailbox joins
    components up to and including the first ``*.mbox`` one, with the
    ``.mbox`` suffix stripped (behavior 9). Returns ``(None, "")`` for paths
    outside the root or with no ``*.mbox`` ancestor (behavior 11, F7) —
    callers skip and record, never fail.

    Symlink handling (live-verified defect): the primary check is lexical —
    ``os.path.abspath`` normalizes ``..``/``.`` WITHOUT following symlinks —
    so a symlinked mail root, or a symlinked directory component inside it,
    keeps its files attributed under the root instead of "escaping" through
    the link chain to a real location whose prefix no longer matches. When
    the spellings differ (e.g. the file is given via the real location of a
    symlinked root), fall back to resolving BOTH sides fully — still
    consistent. Genuine escapes fail both checks.
    """
    lexical_root = pathlib.Path(os.path.abspath(root))
    lexical_path = pathlib.Path(os.path.abspath(path))
    if lexical_path.is_relative_to(lexical_root):
        parts = lexical_path.relative_to(lexical_root).parts
    else:
        resolved_root = root.resolve()
        resolved_path = path.resolve()
        if not resolved_path.is_relative_to(resolved_root):
            return (None, "")
        parts = resolved_path.relative_to(resolved_root).parts
    if len(parts) < 2:
        return (None, "")
    account = parts[0]
    for i in range(1, len(parts) - 1):
        if parts[i].endswith(".mbox"):
            mailbox_parts = list(parts[1:i]) + [parts[i][: -len(".mbox")]]
            return (account, "/".join(mailbox_parts))
    return (None, "")


def message_id_from_name(name: str) -> int:
    """Numeric message_id from an .emlx file name (F0 — the single owner).

    ``12345.emlx`` -> 12345 and ``12345.partial.emlx`` -> 12345; a non-numeric
    leading segment raises ValueError (callers skip + record the file).
    """
    return int(name.split(".", 1)[0])
