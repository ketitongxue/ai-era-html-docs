#!/usr/bin/env python3
"""Rename tracked articles in place using their HTML titles (dry-run by default).

Only basenames change. The report records the original content digest and each
path mapping. HTML attributes and Markdown links are rewritten without
reserializing article markup. Run with --check in CI to reject pending changes.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import subprocess
import sys
import tempfile
import unicodedata
from urllib.parse import quote, unquote, urlsplit, urlunsplit


SITE_SUFFIX = " | AI 纪元"
MAX_FILENAME_BYTES = 240
REPLACEMENTS = str.maketrans('/\\:*?"<>|', '／＼：＊？＂＜＞｜')
RESERVED = re.compile(r"^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", re.I)
LINK_ATTRIBUTES = {"href", "src", "action", "formaction", "poster", "cite", "data", "longdesc", "xlink:href"}
CODE_TAGS = {"pre", "code", "script", "style", "textarea", "title"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
ATTRIBUTE = re.compile(r'''([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?''')


class RenameError(RuntimeError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


class TitleParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.current = None
        self.parts = []
        self.titles = []
        self.headings = []
        self.ignored = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.ignored += 1
        if tag in {"title", "h1"} and self.current is None:
            self.current = tag
            self.parts = []

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.ignored = max(0, self.ignored - 1)
        if tag == self.current:
            target = self.titles if tag == "title" else self.headings
            target.append(normalize_text("".join(self.parts)))
            self.current = None

    def handle_data(self, data):
        if self.current and not self.ignored:
            self.parts.append(data)


def extract_title(content: str, fallback: str) -> tuple[str, str]:
    parser = TitleParser()
    parser.feed(content)
    parser.close()
    for source, values in (("title", parser.titles), ("h1", parser.headings), ("filename", [fallback])):
        for value in values:
            title = normalize_text(value)
            if title.endswith(SITE_SUFFIX):
                title = title[:-len(SITE_SUFFIX)].rstrip()
            if title:
                return title, source
    return "未命名", "fallback"


def safe_stem(value: str) -> str:
    value = normalize_text(value).translate(REPLACEMENTS)
    value = "".join(" " if unicodedata.category(char) == "Cc" else char for char in value)
    value = normalize_text(value).rstrip(". ")
    if not value or value in {".", ".."}:
        value = "未命名"
    if value.startswith(".") or RESERVED.match(value):
        value = "_" + value
    return value


def shorten(value: str, limit: int) -> str:
    if len(value.encode("utf-8")) <= limit:
        return value
    suffix = "~" + digest(value.encode("utf-8"))[:12]
    budget = limit - len(suffix)
    if budget < 1:
        raise RenameError("Filename byte budget is too small")
    prefix = value.encode("utf-8")[:budget].decode("utf-8", errors="ignore").rstrip(". ")
    return prefix + suffix


def filename_for_title(title: str) -> str:
    return shorten(safe_stem(title), MAX_FILENAME_BYTES - len(".html")) + ".html"


def collision_filename(title: str, original_stem: str) -> str:
    token = shorten(safe_stem(original_stem), 80)
    suffix = "（" + token + "）.html"
    budget = MAX_FILENAME_BYTES - len(suffix.encode("utf-8"))
    return shorten(safe_stem(title), budget) + suffix


def existing_collision_filename(title: str, basename: str) -> bool:
    if not basename.endswith("）.html"):
        return False
    for match in re.finditer("（", basename):
        token = basename[match.end():-len("）.html")]
        if token and collision_filename(title, token) == basename:
            return True
    return False


def path_key(path: str) -> str:
    return unicodedata.normalize("NFC", path).casefold()


def tracked_paths(root: Path) -> list[str]:
    try:
        raw = subprocess.check_output(["git", "ls-files", "-z", "--cached"], cwd=root)
    except subprocess.CalledProcessError as error:
        raise RenameError("--root must be a Git working tree") from error
    paths = sorted(set(raw.decode("utf-8").split("\0")) - {""})
    for path in paths:
        if PurePosixPath(path).is_absolute() or ".." in PurePosixPath(path).parts:
            raise RenameError(f"Unsafe tracked path: {path!r}")
    return paths


def read_regular(root: Path, relative: str) -> bytes:
    path = root / relative
    # A symlink in either the leaf or an ancestor must not escape the repository.
    for part in (path, *path.parents):
        if part == root:
            break
        if part.is_symlink():
            raise RenameError(f"Symlink is not an editable article: {relative}")
    try:
        if not stat.S_ISREG(path.stat().st_mode):
            raise RenameError(f"Tracked file is not a regular file: {relative}")
        return path.read_bytes()
    except FileNotFoundError as error:
        raise RenameError(f"Tracked file is missing: {relative}") from error


def decode_content(data: bytes, path: str) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RenameError(f"Expected UTF-8 content: {path}") from error


def infer_pages_bases(root: Path) -> list[str]:
    result = subprocess.run(["git", "remote", "get-url", "origin"], cwd=root, capture_output=True, text=True)
    match = re.search(r"github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?$", result.stdout.strip())
    if not match:
        return []
    owner, repo = match.groups()
    prefix = "" if repo.lower() == f"{owner}.github.io".lower() else repo + "/"
    return [f"https://{owner}.github.io/{prefix}"]


@dataclass
class ResolvedURL:
    target: str
    parts: object
    route_prefix: str
    kind: str


class LinkRewriter:
    def __init__(self, mapping: dict[str, str], tracked: set[str], pages_bases: list[str]):
        self.mapping = mapping
        self.tracked = tracked
        self.final_paths = (tracked - set(mapping)) | set(mapping.values())
        self.bases = []
        for value in pages_bases:
            base = urlsplit(value)
            if base.scheme not in {"http", "https"} or not base.netloc or base.query or base.fragment:
                raise RenameError(f"Invalid Pages base URL: {value}")
            self.bases.append((base.netloc.lower(), unquote(base.path).rstrip("/") + "/"))
        self.references = []

    def resolve(self, source: str, value: str) -> ResolvedURL | None:
        try:
            parts = urlsplit(value)
        except ValueError:
            return None
        if not parts.path or parts.scheme not in {"", "http", "https"}:
            return None
        try:
            pathname = unquote(parts.path, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        prefix = ""
        if parts.netloc:
            bases = [base_path for host, base_path in self.bases if host == parts.netloc.lower() and pathname.startswith(base_path)]
            if not bases:
                return None
            prefix = max(bases, key=len)
            relative = pathname[len(prefix):]
            kind = "absolute"
        elif parts.scheme:
            return None
        elif pathname.startswith("/"):
            bases = [base_path for _, base_path in self.bases if base_path != "/" and pathname.startswith(base_path)]
            prefix = max(bases, key=len) if bases else "/"
            relative = pathname[len(prefix):]
            kind = "root"
        else:
            relative = posixpath.join(posixpath.dirname(source), pathname)
            kind = "relative"
        target = posixpath.normpath(relative)
        if target == ".." or target.startswith("../") or not target.lower().endswith((".html", ".htm")):
            return None
        return ResolvedURL(target, parts, prefix, kind)

    def rewrite(self, source: str, value: str) -> str:
        resolved = self.resolve(source, value)
        if resolved is None:
            return value
        target = resolved.target
        destination = self.mapping.get(target, target)
        replacement = value
        if destination != target:
            if resolved.kind == "relative":
                pathname = posixpath.relpath(destination, posixpath.dirname(source) or ".")
                if resolved.parts.path.startswith("./") and not pathname.startswith("../"):
                    pathname = "./" + pathname
            else:
                pathname = resolved.route_prefix + destination
            encoded = quote(pathname, safe="/!$&'()*+,;=:@-._~")
            replacement = urlunsplit((resolved.parts.scheme, resolved.parts.netloc, encoded,
                                      resolved.parts.query, resolved.parts.fragment))
            # urlunsplit drops empty query/fragment delimiters; retain them too.
            if "?" in value.split("#", 1)[0] and not resolved.parts.query:
                before, separator, after = replacement.partition("#")
                replacement = before + "?" + (separator + after if separator else "")
            if value.endswith("#") and not resolved.parts.fragment:
                replacement += "#"
        self.references.append({"source": source, "url": value, "target": target,
                                "newTarget": destination, "rewritten": replacement != value,
                                "existedBefore": target in self.tracked,
                                "existsAfter": destination in self.final_paths})
        return replacement

    def audit(self) -> dict:
        return {
            "localHtmlLinksChecked": len(self.references),
            "rewrittenLinks": sum(item["rewritten"] for item in self.references),
            "preExistingBrokenLinks": [item for item in self.references if not item["existedBefore"]],
            "newBrokenLinks": [item for item in self.references if item["existedBefore"] and not item["existsAfter"]],
            "references": self.references,
        }


class HTMLLinks(HTMLParser):
    def __init__(self, content: str, source: str, rewriter: LinkRewriter, protected=()):
        super().__init__(convert_charrefs=False)
        self.content = content
        self.source = source
        self.rewriter = rewriter
        self.protected = protected
        self.stack = []
        self.edits = []
        self.line_offsets = [0]
        self.line_offsets.extend(match.end() for match in re.finditer("\n", content))

    def current_offset(self):
        line, col = self.getpos()
        return self.line_offsets[line - 1] + col

    def handle_starttag(self, tag, attrs):
        offset = self.current_offset()
        suppressed = any(parent in CODE_TAGS for parent in self.stack) or tag in CODE_TAGS
        suppressed = suppressed or any(start <= offset < end for start, end in self.protected)
        if not suppressed:
            raw = self.get_starttag_text()
            tag_end = re.match(r"<\s*[^\s>/]+", raw).end()
            for match in ATTRIBUTE.finditer(raw, tag_end):
                if match.group(1).lower() not in LINK_ATTRIBUTES:
                    continue
                group = next((index for index in (2, 3, 4) if match.group(index) is not None), None)
                if group is None:
                    continue
                value = html.unescape(match.group(group))
                replacement = self.rewriter.rewrite(self.source, value)
                if replacement != value:
                    replacement = html.escape(replacement, quote=True)
                    if group == 4:
                        replacement = '"' + replacement + '"'
                    self.edits.append((offset + match.start(group), offset + match.end(group), replacement))
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in self.stack:
            position = len(self.stack) - 1 - self.stack[::-1].index(tag)
            del self.stack[position:]


def markdown_protected(content: str) -> list[tuple[int, int]]:
    """Protect fenced/indented code, inline backticks, and HTML code/comments."""
    ranges = []
    fence = None
    offset = 0
    for line in content.splitlines(keepends=True):
        match = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if fence:
            if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= fence[1] and not line[match.end():].strip():
                ranges.append((fence[2], offset + len(line)))
                fence = None
        elif match:
            fence = (match.group(1)[0], len(match.group(1)), offset)
        elif line.startswith(("    ", "\t")):
            ranges.append((offset, offset + len(line)))
        offset += len(line)
    if fence:
        ranges.append((fence[2], len(content)))
    for match in re.finditer(r"(`+)(?!`)(.*?)\1(?!`)", content, re.S):
        ranges.append(match.span())
    for match in re.finditer(r"<!--.*?-->|<(pre|code|script|style|textarea)\b[^>]*>.*?</\1\s*>", content, re.I | re.S):
        ranges.append(match.span())
    return ranges


def markdown_link_edits(content: str, source: str, rewriter: LinkRewriter, protected) -> list[tuple[int, int, str]]:
    edits = []
    seen = set()

    def add(start, end):
        if (start, end) in seen or any(start < stop and end > begin for begin, stop in protected):
            return
        seen.add((start, end))
        raw = content[start:end]
        value = html.unescape(re.sub(r"\\([!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])", r"\1", raw))
        replacement = rewriter.rewrite(source, value)
        if replacement != value:
            edits.append((start, end, replacement))

    # Inline destinations, with angle brackets or balanced parentheses.
    for match in re.finditer(r"!?\[(?:\\.|[^\]\\\n])*\]\([ \t]*", content):
        start = match.end()
        if any(begin <= match.start() < end for begin, end in protected):
            continue
        if start < len(content) and content[start] == "<":
            end = content.find(">", start + 1)
            if end != -1 and "\n" not in content[start:end]:
                add(start + 1, end)
            continue
        depth = 0
        end = start
        while end < len(content):
            char = content[end]
            if char == "\\" and end + 1 < len(content):
                end += 2
                continue
            if char == "(":
                depth += 1
            elif char == ")":
                if depth == 0:
                    break
                depth -= 1
            elif char.isspace() and depth == 0:
                break
            end += 1
        if end > start and end < len(content):
            add(start, end)
    # CommonMark reference definitions.
    pattern = r"^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]+)>|(\S+))"
    for match in re.finditer(pattern, content, re.M):
        group = 1 if match.group(1) is not None else 2
        add(*match.span(group))
    return edits


def rewrite_document(content: str, source: str, rewriter: LinkRewriter) -> str:
    protected = markdown_protected(content) if source.lower().endswith((".md", ".markdown")) else []
    parser = HTMLLinks(content, source, rewriter, protected)
    parser.feed(content)
    parser.close()
    edits = parser.edits
    if source.lower().endswith((".md", ".markdown")):
        edits += markdown_link_edits(content, source, rewriter, protected + [(start, end) for start, end, _ in edits])
    edits.sort()
    for previous, current in zip(edits, edits[1:]):
        if previous[1] > current[0]:
            raise RenameError(f"Overlapping link replacements in {source}")
    for start, end, replacement in reversed(edits):
        content = content[:start] + replacement + content[end:]
    return content


@dataclass
class Plan:
    root: Path
    entries: list[dict]
    mapping: dict[str, str]
    originals: dict[str, bytes]
    replacements: dict[str, bytes]
    report: dict


def preflight_targets(root: Path, mapping: dict[str, str], tracked: list[str]):
    groups = defaultdict(list)
    for source in tracked:
        groups[path_key(mapping.get(source, source))].append(source)
    conflicts = [values for values in groups.values() if len(values) > 1]
    if conflicts:
        raise RenameError("Final tracked paths collide (NFC/casefold): " + json.dumps(conflicts, ensure_ascii=False))
    for source, destination in mapping.items():
        if source == destination:
            continue
        target = root / destination
        for existing in target.parent.iterdir():
            if path_key(existing.name) == path_key(target.name):
                relative = existing.relative_to(root).as_posix()
                # A tracked source that is itself moving is safe after staging.
                if relative not in mapping or mapping[relative] == relative:
                    raise RenameError(f"Rename target already exists: {destination} (occupied by {relative})")


def make_plan(root: Path, scope: str = "docs", pages_bases: list[str] | None = None) -> Plan:
    root = root.resolve()
    scope = scope.replace("\\", "/").strip("/")
    if not scope or scope == "." or ".." in PurePosixPath(scope).parts:
        raise RenameError("--scope must be a nonempty repository-relative directory")
    tracked = tracked_paths(root)
    documents = [path for path in tracked if path.lower().endswith((".html", ".htm", ".md", ".markdown"))]
    originals = {path: read_regular(root, path) for path in documents}
    contents = {path: decode_content(data, path) for path, data in originals.items()}
    articles = [path for path in documents if path.startswith(scope + "/") and path.lower().endswith((".html", ".htm"))]
    if not articles:
        raise RenameError(f"No tracked HTML articles in scope: {scope}")
    entries = []
    title_groups = defaultdict(list)
    for path in articles:
        title, source = extract_title(contents[path], PurePosixPath(path).stem)
        filename = filename_for_title(title)
        destination = str(PurePosixPath(path).with_name(filename))
        warnings = []
        if source != "title":
            warnings.append(f"Title fallback: {source}")
        if len((safe_stem(title) + ".html").encode("utf-8")) > MAX_FILENAME_BYTES:
            warnings.append(f"Title truncated to {MAX_FILENAME_BYTES} UTF-8 filename bytes with SHA-256 suffix")
        entry = {"oldPath": path, "newPath": destination, "title": title, "titleSource": source,
                 "sha256": digest(originals[path]), "warnings": warnings}
        entries.append(entry)
        title_groups[path_key(destination)].append(entry)
    for group in title_groups.values():
        if len(group) < 2:
            continue
        # The source already using the canonical spelling keeps that name.
        canonical = next((entry for entry in group if path_key(entry["oldPath"]) == path_key(entry["newPath"])), None)
        for entry in group:
            if entry is canonical:
                continue
            original = PurePosixPath(entry["oldPath"])
            filename = (original.name if existing_collision_filename(entry["title"], original.name)
                        else collision_filename(entry["title"], original.stem))
            entry["newPath"] = str(original.with_name(filename))
            entry["warnings"].append("Duplicate title: appended original filename for disambiguation")
    mapping = {entry["oldPath"]: entry["newPath"] for entry in entries}
    preflight_targets(root, mapping, tracked)
    bases = infer_pages_bases(root) if pages_bases is None else pages_bases
    rewriter = LinkRewriter(mapping, set(tracked), bases)
    replacements = {}
    rewritten_files = []
    for path, content in contents.items():
        updated = rewrite_document(content, path, rewriter).encode("utf-8")
        if updated != originals[path]:
            rewritten_files.append({"path": path, "newPath": mapping.get(path, path),
                                    "beforeSha256": digest(originals[path]), "afterSha256": digest(updated)})
        if updated != originals[path] or mapping.get(path, path) != path:
            replacements[path] = updated
    audit = rewriter.audit()
    if audit["newBrokenLinks"]:
        raise RenameError("Link audit found newly broken links")
    for entry in entries:
        entry["afterSha256"] = digest(replacements.get(entry["oldPath"], originals[entry["oldPath"]]))
    report = {
        "schemaVersion": 1, "mode": "dry-run", "scope": scope, "pagesBaseUrls": bases,
        "summary": {"articles": len(entries), "renamed": sum(a != b for a, b in mapping.items()),
                    "unchangedNames": sum(a == b for a, b in mapping.items()),
                    "filesWithLinkUpdates": len(rewritten_files),
                    "warnings": sum(bool(entry["warnings"]) for entry in entries)},
        "entries": entries, "rewrittenFiles": rewritten_files, "linkAudit": audit,
    }
    return Plan(root, entries, mapping, originals, replacements, report)


def apply_plan(plan: Plan):
    """Stage all replacement bytes first; retain originals until verification.

    Each filesystem move uses os.replace. The complete multi-file operation is
    not crash-atomic, but ordinary failures roll back using retained originals.
    A process interruption can be recovered from the printed transaction path.
    """
    if not plan.replacements:
        plan.report["mode"] = "applied"
        return
    preflight_targets(plan.root, plan.mapping, tracked_paths(plan.root))
    for path, expected in plan.originals.items():
        if read_regular(plan.root, path) != expected:
            raise RenameError(f"File changed since planning: {path}")
    transaction = Path(tempfile.mkdtemp(prefix=".title-rename-", dir=plan.root))
    staged = transaction / "new"
    backup = transaction / "originals"
    staged.mkdir()
    backup.mkdir()
    installed = []
    moved = []
    succeeded = False
    manifest = {"files": [{"oldPath": path, "newPath": plan.mapping.get(path, path), "backup": str(index)}
                          for index, path in enumerate(plan.replacements)]}
    (transaction / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Transaction backups: {transaction}", file=sys.stderr)
    try:
        for index, (path, data) in enumerate(plan.replacements.items()):
            temp = staged / str(index)
            with temp.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            temp.chmod(stat.S_IMODE((plan.root / path).stat().st_mode))
        # Evacuating all sources before publishing targets also handles swaps.
        for index, path in enumerate(plan.replacements):
            os.replace(plan.root / path, backup / str(index))
            moved.append((path, backup / str(index)))
        for index, path in enumerate(plan.replacements):
            destination = plan.root / plan.mapping.get(path, path)
            if destination.exists() or destination.is_symlink():
                raise RenameError(f"Target appeared during apply: {destination}")
            os.replace(staged / str(index), destination)
            installed.append(destination)
        for path, data in plan.replacements.items():
            if read_regular(plan.root, plan.mapping.get(path, path)) != data:
                raise RenameError(f"Post-write verification failed: {path}")
        succeeded = True
    except BaseException:
        for destination in reversed(installed):
            destination.unlink()
        for path, saved in reversed(moved):
            os.replace(saved, plan.root / path)
        raise
    finally:
        # Never delete recovery material if a rollback itself failed.
        if not any(backup.iterdir()) or succeeded:
            if succeeded:
                for saved in backup.iterdir():
                    saved.unlink()
            for saved in staged.iterdir():
                saved.unlink()
            staged.rmdir()
            backup.rmdir()
            (transaction / "manifest.json").unlink()
            transaction.rmdir()
    plan.report["mode"] = "applied"


def write_report(path: Path, report: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--scope", default="docs", help="Repository-relative directory prefix (default: docs)")
    parser.add_argument("--report", type=Path, help="Write the complete JSON mapping and link audit")
    parser.add_argument("--pages-base-url", action="append", help="Recognized site URL prefix; repeatable, default inferred from origin")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="Apply the reviewed changes")
    mode.add_argument("--check", action="store_true", help="Dry-run; exit 1 if renaming or link updates are needed")
    args = parser.parse_args(argv)
    try:
        plan = make_plan(args.root, args.scope, args.pages_base_url)
        if args.report:
            report_path = args.report.resolve()
            occupied = {plan.root / path for path in tracked_paths(plan.root)} | {plan.root / path for path in plan.mapping.values()}
            if report_path in occupied:
                raise RenameError("--report must not overwrite a source or destination document")
            write_report(report_path, plan.report)
        if args.apply:
            apply_plan(plan)
            if args.report:
                write_report(args.report.resolve(), plan.report)
        print(json.dumps({"mode": plan.report["mode"], **plan.report["summary"],
                          "localHtmlLinksChecked": plan.report["linkAudit"]["localHtmlLinksChecked"],
                          "preExistingBrokenLinks": len(plan.report["linkAudit"]["preExistingBrokenLinks"]),
                          "newBrokenLinks": len(plan.report["linkAudit"]["newBrokenLinks"])}, ensure_ascii=False))
        return 1 if args.check and plan.replacements else 0
    except (RenameError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
