"""Pure ``.emlx`` parsing for the fruitmail indexer.

Turns raw ``.emlx`` bytes (``<byte-count>\\n<MIME message><binary plist footer>``)
into ``(subject, sender, content, date_sent)``. Produces NO message_id — that is
owned by ``paths.message_id_from_name`` (F0).

Stdlib only: ``email``, ``html.parser``, ``plistlib``.
"""

from __future__ import annotations

import email
import email.message
import email.policy
import email.utils
import plistlib
import sys
from dataclasses import dataclass
from datetime import timezone
from html.parser import HTMLParser
from typing import Optional

#: Files larger than this are skipped outright (behavior 8).
MAX_EMLX_BYTES = 25 * 1024 * 1024


@dataclass(frozen=True)
class ParsedEmail:
    """Parsed .emlx payload. Deliberately has NO message_id field (F0)."""

    subject: Optional[str]
    sender: Optional[str]
    content: str
    date_sent: Optional[int]


class _HtmlTextExtractor(HTMLParser):
    """Collect visible text, dropping <script>/<style> contents entirely."""

    _SKIP_TAGS = {"script", "style"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._chunks: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self._chunks.append(data)

    @property
    def text(self) -> str:
        return " ".join(self._chunks)


def strip_html(html: str) -> str:
    """Strip tags (script/style contents removed) and collapse whitespace."""
    extractor = _HtmlTextExtractor()
    try:
        extractor.feed(html)
        extractor.close()
    except Exception as exc:
        # Keep whatever text was collected before the parse hiccup, but
        # record it on stderr (T40) instead of silently truncating the body —
        # matching the module's warn-on-stderr convention (_record_skip).
        print(f"fruitmail-indexer: html-parse-error: {exc}", file=sys.stderr)
    return _collapse_ws(extractor.text)


def _collapse_ws(text: str) -> str:
    return " ".join(text.split())


def _part_text(part: email.message.Message) -> Optional[str]:
    """Decoded text of a leaf part, or None if it cannot be decoded."""
    try:
        payload = part.get_payload(decode=True)
        if payload is None:
            payload_str = part.get_payload()
            return payload_str if isinstance(payload_str, str) else None
        charset = part.get_content_charset() or "utf-8"
        try:
            return payload.decode(charset, errors="replace")
        except LookupError:  # unknown charset label: keep the text as UTF-8
            return payload.decode("utf-8", errors="replace")
    except Exception:
        return None


def extract_body(msg: email.message.Message) -> str:
    """Joined text/plain parts; else the first text/html part, tag-stripped.

    Whitespace is collapsed in either case (behavior 7).
    """
    plain_parts: list[str] = []
    first_html: Optional[str] = None
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        content_type = part.get_content_type()
        if content_type == "text/plain":
            text = _part_text(part)
            if text is not None:
                plain_parts.append(text)
        elif content_type == "text/html" and first_html is None:
            first_html = _part_text(part)
    if plain_parts:
        return _collapse_ws("\n".join(plain_parts))
    if first_html is not None:
        return strip_html(first_html)
    return ""


def parse_date_epoch(msg: email.message.Message) -> Optional[int]:
    """Unix epoch seconds from the ``Date`` header, or None."""
    date_header = msg.get("Date")
    if not date_header:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(date_header)
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        # A Date header with no offset (or `-0000`) parses to a naive
        # datetime; .timestamp() would then interpret it in the indexing
        # machine's local TZ instead of as UTC.
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def _plist_date_sent(footer: bytes) -> Optional[int]:
    """Fallback epoch from the trailing plist's ``date-sent`` key."""
    if not footer:
        return None
    try:
        info = plistlib.loads(footer)
    except Exception:
        return None
    value = info.get("date-sent") if isinstance(info, dict) else None
    if isinstance(value, (int, float)):
        return int(value)
    return None


def parse_emlx(raw: bytes) -> Optional[ParsedEmail]:
    """Parse raw .emlx bytes; None on malformed/oversized input (behavior 6, 8).

    First line is the MIME byte count; the MIME block is sliced out and the
    trailing binary plist is ignored (except as a date_sent fallback).
    """
    if len(raw) > MAX_EMLX_BYTES:
        return None
    newline = raw.find(b"\n")
    if newline < 0:
        return None
    try:
        count = int(raw[:newline].strip())
    except ValueError:
        return None
    mime_start = newline + 1
    if count < 0 or mime_start + count > len(raw):
        return None
    mime = raw[mime_start : mime_start + count]
    footer = raw[mime_start + count :]
    try:
        msg = email.message_from_bytes(mime, policy=email.policy.default)
    except Exception:
        return None
    subject_raw = msg.get("Subject")
    subject = str(subject_raw) if subject_raw is not None else None
    sender_raw = msg.get("From")
    sender = str(sender_raw) if sender_raw is not None else None
    date_sent = parse_date_epoch(msg)
    if date_sent is None:
        date_sent = _plist_date_sent(footer)
    # F21: genuinely undated mail stays None (NULL in index.db) rather than
    # a 0 sentinel — that displayed as the misleading epoch 1970 and
    # permanently excluded the mail from --days-filtered body search for the
    # wrong reason (a real question of "is 1970 in range?", never "unknown").
    # NULL >= <cutoff> is SQL-false, so undated mail is still excluded from
    # any --days-windowed search (honest: we don't know when it was sent)
    # while remaining visible in a full-index (no --days) search.
    return ParsedEmail(
        subject=subject,
        sender=sender,
        content=extract_body(msg),
        date_sent=date_sent,
    )
