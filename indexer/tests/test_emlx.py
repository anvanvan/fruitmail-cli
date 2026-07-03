"""RED tests for indexer/emlx.py — pure .emlx parsing (behaviors 6, 7, 8).

parse_emlx returns (subject, sender, content, date_sent) and NO message_id (F0).
The module under test is imported lazily inside each test so a missing module
fails the test rather than erroring the collection.
"""

from __future__ import annotations

import email.utils
import os
import time

import plistlib

from conftest import make_emlx_bytes, make_mime


def _parse_emlx():
    from emlx import parse_emlx

    return parse_emlx


class TestByteCountSlice:
    def test_extracts_mime_block_and_ignores_trailing_plist(self):
        parse_emlx = _parse_emlx()
        footer = plistlib.dumps({"note": "PLIST-NOISE-TOKEN", "flags": 8590195713})
        raw = make_emlx_bytes(make_mime(body="the needle body text"), footer=footer)

        parsed = parse_emlx(raw)

        assert parsed is not None
        assert "needle body text" in parsed.content
        assert "PLIST-NOISE-TOKEN" not in parsed.content
        assert "PLIST-NOISE-TOKEN" not in (parsed.subject or "")

    def test_parses_subject_sender_and_date_epoch(self):
        parse_emlx = _parse_emlx()
        date_header = "Mon, 6 Jan 2025 10:00:00 +0000"
        raw = make_emlx_bytes(
            make_mime(subject="Quarterly report", sender="alice@example.com", date=date_header)
        )

        parsed = parse_emlx(raw)

        assert parsed is not None
        assert parsed.subject == "Quarterly report"
        assert "alice@example.com" in parsed.sender
        expected_epoch = int(email.utils.parsedate_to_datetime(date_header).timestamp())
        assert parsed.date_sent == expected_epoch

    def test_rfc2047_encoded_word_subject_and_from_are_decoded(self):
        # F3: message_from_bytes without policy=email.policy.default leaves
        # RFC 2047 encoded-words undecoded, breaking FTS + display for
        # non-ASCII mail.
        parse_emlx = _parse_emlx()
        mime = (
            "From: =?UTF-8?B?QWxpY2Ugw4k=?= <alice@example.com>\r\n"
            "Subject: =?UTF-8?B?UsOpc3Vtw6k=?=\r\n"
            "Date: Mon, 6 Jan 2025 10:00:00 +0000\r\n"
            "MIME-Version: 1.0\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "\r\n"
            "body\r\n"
        ).encode("utf-8")

        parsed = parse_emlx(make_emlx_bytes(mime))

        assert parsed is not None
        assert parsed.subject == "Résumé"
        assert "Alice É" in parsed.sender
        assert "=?UTF-8?" not in parsed.subject
        assert "=?UTF-8?" not in parsed.sender

    def test_no_message_id_attribute_on_parsed_email(self):
        # F0: message_id is owned by paths.message_id_from_name, never by emlx.
        parse_emlx = _parse_emlx()
        parsed = parse_emlx(make_emlx_bytes(make_mime()))

        assert parsed is not None
        assert not hasattr(parsed, "message_id")


class TestDateEpochTimezone:
    def test_naive_date_header_is_not_shifted_by_the_indexing_host_local_tz(self):
        # F19: a Date header with no offset (or `-0000`) parses to a naive
        # datetime; .timestamp() must treat it as UTC rather than the
        # indexing host's local TZ.
        parse_emlx = _parse_emlx()
        date_header = "Mon, 6 Jan 2025 10:00:00 -0000"
        raw = make_emlx_bytes(make_mime(date=date_header))

        original_tz = os.environ.get("TZ")
        try:
            os.environ["TZ"] = "America/New_York"
            time.tzset()
            parsed_est = parse_emlx(raw)

            os.environ["TZ"] = "UTC"
            time.tzset()
            parsed_utc = parse_emlx(raw)
        finally:
            if original_tz is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = original_tz
            time.tzset()

        assert parsed_est is not None and parsed_utc is not None
        assert parsed_est.date_sent == parsed_utc.date_sent

        naive = email.utils.parsedate_to_datetime(date_header)
        assert naive.tzinfo is None  # confirms this Date header is the naive case
        import datetime as dt

        expected = int(naive.replace(tzinfo=dt.timezone.utc).timestamp())
        assert parsed_utc.date_sent == expected


class TestBodyExtraction:
    def test_multiple_text_plain_parts_are_joined(self):
        parse_emlx = _parse_emlx()
        boundary = "BOUNDARY42"
        mime = (
            "From: a@example.com\r\n"
            "Subject: multi\r\n"
            "Date: Mon, 6 Jan 2025 10:00:00 +0000\r\n"
            "MIME-Version: 1.0\r\n"
            f'Content-Type: multipart/mixed; boundary="{boundary}"\r\n'
            "\r\n"
            f"--{boundary}\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "\r\n"
            "first part text\r\n"
            f"--{boundary}\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "\r\n"
            "second part text\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")

        parsed = parse_emlx(make_emlx_bytes(mime))

        assert parsed is not None
        assert "first part text" in parsed.content
        assert "second part text" in parsed.content

    def test_html_only_body_is_stripped_and_whitespace_collapsed(self):
        parse_emlx = _parse_emlx()
        html = (
            "<html><head><style>body { color: red; }</style>"
            "<script>alert('evilscriptpayload')</script></head>"
            "<body>  <p>visible   paragraph</p>\n\n<div>another    line</div>  </body></html>"
        )
        mime = make_mime(body=html, content_type="text/html; charset=utf-8")

        parsed = parse_emlx(make_emlx_bytes(mime))

        assert parsed is not None
        assert "visible paragraph" in parsed.content
        assert "another line" in parsed.content
        assert "<" not in parsed.content
        assert "evilscriptpayload" not in parsed.content
        assert "color: red" not in parsed.content
        assert "  " not in parsed.content.strip()

    def test_text_plain_preferred_over_html_in_multipart_alternative(self):
        parse_emlx = _parse_emlx()
        boundary = "ALTBOUND"
        mime = (
            "From: a@example.com\r\n"
            "Subject: alt\r\n"
            "Date: Mon, 6 Jan 2025 10:00:00 +0000\r\n"
            "MIME-Version: 1.0\r\n"
            f'Content-Type: multipart/alternative; boundary="{boundary}"\r\n'
            "\r\n"
            f"--{boundary}\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "\r\n"
            "PLAINMARKER body\r\n"
            f"--{boundary}\r\n"
            "Content-Type: text/html; charset=utf-8\r\n"
            "\r\n"
            "<p>HTMLMARKER body</p>\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")

        parsed = parse_emlx(make_emlx_bytes(mime))

        assert parsed is not None
        assert "PLAINMARKER" in parsed.content
        assert "HTMLMARKER" not in parsed.content

    def test_html_parse_error_is_warned_not_silently_swallowed(self, monkeypatch, capsys):
        # T40: strip_html's bare `except Exception: pass` hid a failed parse
        # (an HTML-only body could silently index as truncated/empty); it
        # must warn on stderr, matching the module's convention.
        import emlx

        def raising_feed(self, data):
            raise ValueError("boom")

        monkeypatch.setattr(emlx._HtmlTextExtractor, "feed", raising_feed)

        result = emlx.strip_html("<p>hello</p>")

        assert result == ""  # nothing collected before the injected failure
        err = capsys.readouterr().err
        assert "html-parse-error" in err
        assert "boom" in err


class TestUndatedMail:
    def test_no_date_header_and_no_plist_fallback_yields_none_not_a_1970_sentinel(self):
        # F21: genuinely undated mail must be None (NULL in index.db), not a
        # 0 sentinel that displayed as 1970 and silently excluded the row
        # from every --days-filtered search for the wrong reason.
        parse_emlx = _parse_emlx()
        mime = (
            "From: a@example.com\r\n"
            "Subject: no date here\r\n"
            "MIME-Version: 1.0\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "\r\n"
            "body with no date header\r\n"
        ).encode("utf-8")
        raw = make_emlx_bytes(mime, footer=b"")  # no plist footer to fall back to either

        parsed = parse_emlx(raw)

        assert parsed is not None
        assert parsed.date_sent is None


class TestMalformedAndOversized:
    def test_non_numeric_byte_count_returns_none(self):
        parse_emlx = _parse_emlx()
        raw = b"notanumber\n" + make_mime()

        assert parse_emlx(raw) is None

    def test_missing_newline_returns_none(self):
        parse_emlx = _parse_emlx()

        assert parse_emlx(b"12345") is None

    def test_byte_count_beyond_raw_length_returns_none(self):
        parse_emlx = _parse_emlx()
        mime = make_mime()
        raw = make_emlx_bytes(mime, byte_count=len(mime) + 999999, footer=b"")

        assert parse_emlx(raw) is None

    def test_oversized_raw_returns_none(self):
        parse_emlx = _parse_emlx()
        big_body = "A" * (26 * 1024 * 1024)  # > 25 MB guard
        raw = make_emlx_bytes(make_mime(body=big_body))

        assert parse_emlx(raw) is None
