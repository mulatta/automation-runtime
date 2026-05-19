"""Project-local CLI for focused Restate documentation lookup.

The tool intentionally presents a tiny search/docs interface to coding agents.
It uses Restate's public llms.txt and markdown pages instead of exposing an MCP
server and its tool list to the model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import NoReturn

INDEX_URL = "https://docs.restate.dev/llms.txt"
DOCS_HOST = "docs.restate.dev"
DEFAULT_MAX_CHARS = 6000
DEFAULT_LIMIT = 8
CACHE_TTL_SECONDS = 24 * 60 * 60
USER_AGENT = "Mozilla/5.0 (compatible; restate-docs-cli/0.1)"

STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "by",
    "for",
    "from",
    "how",
    "in",
    "into",
    "is",
    "of",
    "on",
    "or",
    "the",
    "to",
    "use",
    "with",
}


@dataclass(frozen=True)
class DocItem:
    id: str
    title: str
    url: str
    description: str


@dataclass(frozen=True)
class SearchHit:
    item: DocItem
    score: int


def die(message: str, code: int = 1) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(code)


def cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME")
    root = Path(base) if base else Path.home() / ".cache"
    return root / "restate-docs"


def cache_path_for_url(url: str) -> Path:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return cache_dir() / "pages" / f"{digest}.md"


def is_fresh(path: Path) -> bool:
    if not path.exists():
        return False
    return time.time() - path.stat().st_mtime < CACHE_TTL_SECONDS


def validate_docs_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        die(f"only https URLs are allowed: {url}")
    if parsed.netloc != DOCS_HOST:
        die(f"only {DOCS_HOST} URLs are allowed: {url}")
    return url


def fetch_url(url: str, *, refresh: bool = False, cache_path: Path | None = None) -> str:
    validate_docs_url(url)
    if cache_path and not refresh and is_fresh(cache_path):
        return cache_path.read_text(encoding="utf-8")

    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            text = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        die(f"HTTP {exc.code} while fetching {url}")
    except urllib.error.URLError as exc:
        die(f"failed to fetch {url}: {exc.reason}")

    if cache_path:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(text, encoding="utf-8")
    return text


def fetch_index(*, refresh: bool = False) -> str:
    return fetch_url(INDEX_URL, refresh=refresh, cache_path=cache_dir() / "llms.txt")


def fetch_doc(url: str, *, refresh: bool = False) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.netloc == DOCS_HOST and not parsed.path.endswith(".md"):
        url = urllib.parse.urlunparse(parsed._replace(path=f"{parsed.path}.md"))
    return fetch_url(url, refresh=refresh, cache_path=cache_path_for_url(url))


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "doc"


def id_from_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        return slugify(url)
    last = re.sub(r"\.md$", "", parts[-1])
    return slugify(last)


def unique_ids(items: list[DocItem]) -> list[DocItem]:
    seen: dict[str, int] = {}
    result: list[DocItem] = []
    for item in items:
        base = item.id
        count = seen.get(base, 0)
        seen[base] = count + 1
        if count == 0:
            result.append(item)
            continue

        parsed = urllib.parse.urlparse(item.url)
        parts = [re.sub(r"\.md$", "", part) for part in parsed.path.split("/") if part]
        candidate = slugify("-".join(parts[-2:])) if len(parts) >= 2 else base
        if candidate in seen:
            candidate = f"{candidate}-{count + 1}"
        seen[candidate] = 1
        result.append(DocItem(candidate, item.title, item.url, item.description))
    return result


def parse_llms_index(text: str) -> list[DocItem]:
    items: list[DocItem] = []
    pattern = re.compile(r"^\s*-\s+\[(?P<title>[^\]]+)\]\((?P<url>https://docs\.restate\.dev/[^)]+)\)(?::\s*(?P<description>.*))?\s*$")
    for line in text.splitlines():
        match = pattern.match(line)
        if not match:
            continue
        url = match.group("url")
        description = (match.group("description") or "").strip()
        title = match.group("title").strip()
        items.append(
            DocItem(
                id=slugify(title),
                title=title,
                url=url,
                description=description,
            )
        )
    return unique_ids(items)


def tokenize(text: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    return [token for token in tokens if token not in STOPWORDS and len(token) > 1]


def score_item(item: DocItem, query_tokens: list[str]) -> int:
    title = tokenize(item.title)
    description = tokenize(item.description)
    url_tokens = tokenize(urllib.parse.urlparse(item.url).path.replace("/", " "))
    score = 0
    for token in query_tokens:
        if token in title:
            score += 10
        if token in url_tokens:
            score += 5
        score += description.count(token) * 2
    phrase = " ".join(query_tokens)
    if phrase and phrase in item.title.lower():
        score += 15
    if phrase and phrase in item.description.lower():
        score += 8
    return score


def search_index(items: list[DocItem], query: str, *, limit: int = DEFAULT_LIMIT) -> list[SearchHit]:
    query_tokens = tokenize(query)
    if not query_tokens:
        return []
    hits = [SearchHit(item, score_item(item, query_tokens)) for item in items]
    hits = [hit for hit in hits if hit.score > 0]
    hits.sort(key=lambda hit: (-hit.score, hit.item.title.lower()))
    return hits[:limit]


def resolve_target(items: list[DocItem], target: str) -> DocItem:
    if target.startswith("https://"):
        return DocItem(id=id_from_url(target), title=target, url=validate_docs_url(target), description="")

    exact = [item for item in items if item.id == target]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        die(f"ambiguous id {target!r}; use a URL")

    contains = [item for item in items if target.lower() in item.id.lower()]
    if len(contains) == 1:
        return contains[0]
    if len(contains) > 1:
        choices = ", ".join(item.id for item in contains[:8])
        die(f"ambiguous id {target!r}; matches: {choices}")

    matches = search_index(items, target, limit=5)
    if matches:
        choices = ", ".join(hit.item.id for hit in matches)
        die(f"unknown id {target!r}; closest matches: {choices}")
    die(f"unknown id {target!r}; run `restate-docs search <topic>` first")


def split_sections(markdown: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, str]] = []
    current_heading = "Introduction"
    current_lines: list[str] = []

    for line in markdown.splitlines():
        if re.match(r"^#{1,4}\s+", line) and current_lines:
            sections.append((current_heading, "\n".join(current_lines).strip()))
            current_heading = line.strip()
            current_lines = [line]
        else:
            if re.match(r"^#{1,4}\s+", line):
                current_heading = line.strip()
            current_lines.append(line)

    if current_lines:
        sections.append((current_heading, "\n".join(current_lines).strip()))
    return sections


def score_section(heading: str, body: str, query_tokens: list[str]) -> int:
    heading_tokens = tokenize(heading)
    body_tokens = tokenize(body)
    code_blocks = " ".join(re.findall(r"```.*?```", body, flags=re.DOTALL))
    code_tokens = tokenize(code_blocks)
    score = 0
    for token in query_tokens:
        if token in heading_tokens:
            score += 8
        score += min(body_tokens.count(token), 6)
        score += min(code_tokens.count(token), 4) * 3
    phrase = " ".join(query_tokens)
    if phrase and phrase in heading.lower():
        score += 15
    return score


def extract_snippets(markdown: str, query: str, *, max_chars: int = DEFAULT_MAX_CHARS) -> str:
    sections = split_sections(markdown)
    query_tokens = tokenize(query)
    if not sections:
        return markdown[:max_chars]
    if not query_tokens:
        return sections[0][1][:max_chars]

    ranked = [
        (score_section(heading, body, query_tokens), index, body)
        for index, (heading, body) in enumerate(sections)
    ]
    ranked = [entry for entry in ranked if entry[0] > 0]
    ranked.sort(key=lambda entry: (-entry[0], entry[1]))
    if not ranked:
        return sections[0][1][:max_chars]

    best_score = ranked[0][0]
    threshold = max(2, best_score // 2)
    ranked = [entry for entry in ranked if entry[0] >= threshold]

    selected: list[tuple[int, str]] = []
    total = 0
    for _score, index, body in ranked:
        projected = total + len(body) + 2
        if selected and projected > max_chars:
            continue
        selected.append((index, body))
        total += len(body) + 2
        if total >= max_chars:
            break

    selected.sort(key=lambda entry: entry[0])
    text = "\n\n".join(body for _index, body in selected)
    if len(text) > max_chars:
        text = text[: max_chars - 20].rstrip() + "\n\n[truncated]"
    return text


def print_search_text(query: str, hits: list[SearchHit]) -> None:
    if not hits:
        print(f"No Restate docs matched: {query}")
        return
    for index, hit in enumerate(hits, start=1):
        item = hit.item
        print(f"{index}. {item.title}")
        print(f"   id: {item.id}")
        print(f"   url: {item.url}")
        print(f"   score: {hit.score}")
        if item.description:
            print(f"   hint: {item.description}")


def command_search(args: argparse.Namespace) -> None:
    query = " ".join(args.query).strip()
    if not query:
        die("search query is required")
    items = parse_llms_index(fetch_index(refresh=args.refresh))
    hits = search_index(items, query, limit=args.limit)
    if args.json:
        print(
            json.dumps(
                {
                    "query": query,
                    "results": [
                        {"score": hit.score, **asdict(hit.item)} for hit in hits
                    ],
                },
                indent=2,
            )
        )
    else:
        print_search_text(query, hits)


def command_docs(args: argparse.Namespace) -> None:
    target = args.target.strip()
    query = " ".join(args.query).strip()
    if not target:
        die("docs target is required")
    if not query:
        die("focused docs query is required")

    items = parse_llms_index(fetch_index(refresh=args.refresh))
    item = resolve_target(items, target)
    markdown = fetch_doc(item.url, refresh=args.refresh)
    snippets = extract_snippets(markdown, query, max_chars=args.max_chars)

    if args.json:
        print(
            json.dumps(
                {
                    "target": target,
                    "id": item.id,
                    "title": item.title,
                    "source": item.url,
                    "query": query,
                    "snippets": snippets,
                },
                indent=2,
            )
        )
        return

    print(f"# {item.title}")
    print()
    print(f"Source: {item.url}")
    print(f"Query: {query}")
    print()
    print("## Relevant snippets")
    print()
    print(snippets)


def command_cache(args: argparse.Namespace) -> None:
    if args.action != "clear":
        die("cache action must be 'clear'")
    directory = cache_dir()
    if directory.exists():
        shutil.rmtree(directory)
    print(f"Cleared {directory}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="restate-docs",
        description="Search and fetch focused snippets from Restate docs.",
    )
    parser.add_argument("--refresh", action="store_true", help="ignore cached docs")
    subparsers = parser.add_subparsers(dest="command", required=True)

    search = subparsers.add_parser("search", help="search Restate docs")
    search.add_argument("--json", action="store_true", help="emit JSON")
    search.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="max results")
    search.add_argument("query", nargs="+", help="search query")
    search.set_defaults(func=command_search)

    docs = subparsers.add_parser("docs", help="fetch focused snippets for an id or URL")
    docs.add_argument("--json", action="store_true", help="emit JSON")
    docs.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS, help="snippet budget")
    docs.add_argument("target", help="id from search results or docs URL")
    docs.add_argument("query", nargs="+", help="focused docs query")
    docs.set_defaults(func=command_docs)

    cache = subparsers.add_parser("cache", help="manage cache")
    cache.add_argument("action", choices=["clear"], help="cache action")
    cache.set_defaults(func=command_cache)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
