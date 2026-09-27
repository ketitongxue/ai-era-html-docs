#!/usr/bin/env python3
"""Check article links before publishing; use --fix after generating new HTML.

    python3 scripts/external_links.py
    python3 scripts/external_links.py --fix
    python3 -m unittest discover -s scripts -p 'test_*.py'

External web links open outside the embedded reader. Local navigation and
explicit downloads keep their existing behavior. Only link attributes change.
"""

import argparse
import html
from html.parser import HTMLParser
from pathlib import Path
import re
from urllib.parse import urlsplit


SITE_HOST = "ketitongxue.github.io"
ATTR_PATTERN = re.compile(
    r'''\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?'''
)


def is_external_link(attrs):
    if "download" in attrs:
        return False
    href = (attrs.get("href") or "").strip()
    url = urlsplit("https:" + href if href.startswith("//") else href)
    return url.scheme.lower() in {"http", "https"} and bool(url.netloc) and url.hostname != SITE_HOST


def update_attributes(tag, replacements):
    """Preserve the original tag bytes except target/rel, including href escaping."""
    edits = []
    for match in ATTR_PATTERN.finditer(tag):
        name = match.group(1).lower()
        if name in replacements:
            value = html.escape(replacements.pop(name), quote=True)
            edits.append((match.start(), match.end(), f' {name}="{value}"'))
    end = len(tag) - (2 if tag.endswith("/>") else 1)
    additions = "".join(f' {name}="{html.escape(value, quote=True)}"' for name, value in replacements.items())
    edits.append((end, end, additions))
    for start, end, replacement in reversed(edits):
        tag = tag[:start] + replacement + tag[end:]
    return tag


class ExternalLinkParser(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.line_offsets = [0]
        self.line_offsets.extend(match.end() for match in re.finditer("\n", source))
        self.edits = []
        self.external_count = 0

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag != "a" or not is_external_link(attrs):
            return
        self.external_count += 1
        rel = (attrs.get("rel") or "").split()
        rel_lower = {token.lower() for token in rel}
        if attrs.get("target") == "_blank" and {"noopener", "noreferrer"} <= rel_lower:
            return
        rel.extend(token for token in ("noopener", "noreferrer") if token not in rel_lower)
        original = self.get_starttag_text()
        replacement = update_attributes(original, {"target": "_blank", "rel": " ".join(rel)})
        line, column = self.getpos()
        start = self.line_offsets[line - 1] + column
        self.edits.append((start, start + len(original), replacement, line, attrs["href"]))

    handle_startendtag = handle_starttag


def normalize_html(source):
    parser = ExternalLinkParser(source)
    parser.feed(source)
    parser.close()
    result = source
    for start, end, replacement, _, _ in reversed(parser.edits):
        result = result[:start] + replacement + result[end:]
    return result, parser


def main():
    cli = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    cli.add_argument("--fix", action="store_true", help="write safe external-link attributes to article HTML")
    args = cli.parse_args()
    root = Path(__file__).resolve().parent.parent
    paths = sorted((root / "docs").rglob("*.html"))
    changed = external_count = 0
    for path in paths:
        source = path.read_bytes().decode("utf-8")
        result, parser = normalize_html(source)
        external_count += parser.external_count
        if not parser.edits:
            continue
        changed += len(parser.edits)
        if args.fix:
            path.write_bytes(result.encode("utf-8"))
        else:
            for _, _, _, line, href in parser.edits:
                print(f"{path.relative_to(root)}:{line}: needs target=_blank and rel=noopener noreferrer: {href}")
    print(f"Checked {len(paths)} articles and {external_count} external links; {changed} {'fixed' if args.fix else 'need fixing'}.")
    return 0 if args.fix or not changed else 1


if __name__ == "__main__":
    raise SystemExit(main())
