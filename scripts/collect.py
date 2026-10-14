"""Collect public Munpia cutlines; standard library only, no source-site dependency."""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
KST = timezone(timedelta(hours=9))
TARGETS = tuple(range(20, 201, 20))
SOURCES = {
    "today": "https://www.munpia.com/best/today?displayType=LIST",
    "new": "https://www.munpia.com/best/new.novel.today?displayType=LIST",
}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)

    def text(self):
        return "".join(child.text() if isinstance(child, Node) else child for child in self.children)

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def with_class(self, name):
        return next((n for n in self.walk() if name in n.attrs.get("class", "").split()), None)


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Node("document")
        self.stack = [self.root]
        self.feed(source)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag, dict(attrs)))

    def handle_endtag(self, tag):
        for position in range(len(self.stack) - 1, 0, -1):
            if self.stack[position].tag == tag:
                del self.stack[position:]
                break

    def handle_data(self, text):
        self.stack[-1].children.append(text)


def parse_rankings(source):
    """Read ranking anchors as a DOM tree; preserve titles containing inline tags."""
    entries = {}
    for anchor in Document(source).root.walk():
        if anchor.tag != "a":
            continue
        link = re.search(r"/novel/detail/(\d+)(?:[/?#]|$)", anchor.attrs.get("href", ""))
        rank_node = anchor.with_class("num")
        views_node = anchor.with_class("view-count")
        if not link or rank_node is None or views_node is None:
            continue
        rank_text = rank_node.text().strip()
        views_text = views_node.text().strip().replace(",", "")
        if not rank_text.isdigit() or not views_text.isdigit():
            continue
        title_node = anchor.with_class("title-wrap")
        if title_node is None:
            title_node = anchor.with_class("title")
        author_node = anchor.with_class("author")
        rank = int(rank_text)
        if not 1 <= rank <= 200 or title_node is None:
            continue
        title = " ".join(title_node.text().split())
        if title:
            entries.setdefault(rank, {
                "novel_id": link.group(1), "title": title,
                "author": " ".join(author_node.text().split()) if author_node else "",
                "views": int(views_text),
            })
    return entries


def make_snapshot(source, timestamp):
    entries = parse_rankings(source)
    cutlines = {}
    for target in TARGETS:
        actual = next((r for r in range(target, max(0, target - 11), -1) if r in entries), None)
        if actual is None:
            raise ValueError(f"{target}위 주변의 조회수를 읽지 못했습니다. 기존 기록은 유지됩니다.")
        cutlines[str(target)] = {**entries[actual], "rank": target, "actual_rank": actual}
    return {"timestamp": timestamp.astimezone(KST).isoformat(timespec="seconds"), "cutlines": cutlines}


def read_json(path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(path)


def persist(data_dir, kind, snapshot):
    moment = datetime.fromisoformat(snapshot["timestamp"]).astimezone(KST)
    key, month, hour = moment.date().isoformat(), moment.strftime("%Y-%m"), moment.hour
    path = data_dir / kind / f"{month}.json"
    records = read_json(path, [])
    # Keep the most recent successful observation in each KST hour, including retries.
    def slot(record):
        return datetime.fromisoformat(record["timestamp"]).astimezone(KST).strftime("%Y-%m-%dT%H")
    current_slot = moment.strftime("%Y-%m-%dT%H")
    existing = next((r for r in records if slot(r) == current_slot), None)
    if existing and datetime.fromisoformat(existing["timestamp"]) > moment:
        return
    records = [r for r in records if slot(r) != current_slot] + [snapshot]
    records.sort(key=lambda r: r["timestamp"])
    write_json(path, records)


def refresh_index(data_dir, attempts=None):
    previous = read_json(data_dir / "index.json", {})
    index = {"schema": 1, "timezone": "Asia/Seoul", "generated_at": datetime.now(KST).isoformat(timespec="seconds"), "series": {}}
    for kind in SOURCES:
        months, latest, count = {}, None, 0
        for path in sorted((data_dir / kind).glob("????-??.json")):
            records = read_json(path, [])
            dates = sorted({datetime.fromisoformat(r["timestamp"]).astimezone(KST).date().isoformat() for r in records})
            if records:
                months[path.stem] = {"file": f"{kind}/{path.name}", "dates": dates, "count": len(records)}
                count += len(records)
                candidate = max(records, key=lambda r: r["timestamp"])
                if latest is None or candidate["timestamp"] > latest["timestamp"]:
                    latest = candidate
        index["series"][kind] = {"months": months, "latest": latest, "count": count,
            "attempt": (attempts or {}).get(kind, previous.get("series", {}).get(kind, {}).get("attempt"))}
    write_json(data_dir / "index.json", index)
    return index


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; MunpiaCutlineArchive/1.0)", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=30) as response:
        content = response.read(5_000_001)
        if len(content) > 5_000_000:
            raise ValueError("응답 크기가 예상 범위를 초과했습니다.")
        charset = response.headers.get_content_charset() or "utf-8"
        return content.decode(charset)


def main():
    parser = argparse.ArgumentParser(description="문피아 커트라인 1회 수집 (예약 실행은 별도 설정)")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "site" / "data")
    parser.add_argument("--kind", choices=["today", "new", "all"], default="all")
    parser.add_argument("--fixture", type=Path, help="검증용 HTML로 실행; 실제 네트워크 요청 없음 (한 종류만 지정)")
    parser.add_argument("--at", help="검증용 ISO 시각; fixture와 함께 사용")
    args = parser.parse_args()
    if (args.fixture and args.kind == "all") or (args.at and not args.fixture):
        parser.error("fixture는 --kind today/new를 지정하고, --at은 fixture와 함께 사용하세요.")
    attempts, failed = {}, False
    for kind in SOURCES if args.kind == "all" else [args.kind]:
        timestamp = datetime.fromisoformat(args.at) if args.at else datetime.now(KST)
        if timestamp.tzinfo is None:
            parser.error("시각에는 +09:00 같은 시간대가 필요합니다.")
        timestamp = timestamp.astimezone(KST)
        try:
            source = args.fixture.read_text(encoding="utf-8") if args.fixture else download(SOURCES[kind])
            snapshot = make_snapshot(source, timestamp)
            persist(args.data_dir, kind, snapshot)
            attempts[kind] = {"timestamp": timestamp.isoformat(timespec="seconds"), "ok": True}
            print(f"{kind}: 저장 완료 ({snapshot['cutlines']['200']['views']:,}회)")
        except Exception as error:
            failed = True
            attempts[kind] = {"timestamp": timestamp.isoformat(timespec="seconds"), "ok": False, "message": str(error)[:250]}
            print(f"{kind}: {error}", file=sys.stderr)
    refresh_index(args.data_dir, attempts)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
