import importlib.util
import json
from datetime import datetime
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("collect", ROOT / "scripts" / "collect.py")
import sys
collect = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = collect
spec.loader.exec_module(collect)


def listing(omit=()):
    return '<html><body>' + ''.join(
        f'<a href="/novel/detail/{rank+10000}"><div class="num">{rank}</div>'
        f'<span class="title-wrap">검증 &amp; <b>작품 {rank}</b></span><div class="author">테스트</div>'
        f'<img src="cover.png"><div class="view-count">{(201-rank)*100:,}</div></a>'
        for rank in range(1,201) if rank not in omit) + '</body></html>'


class CollectorTests(unittest.TestCase):
    def test_dom_and_entities(self):
        records = collect.parse_rankings(listing())
        self.assertEqual(len(records),200)
        self.assertEqual(records[200]['title'],'검증 & 작품 200')
        self.assertEqual(records[20]['views'],18100)

    def test_missing_rank_is_explicit(self):
        snap = collect.make_snapshot(listing(omit=(200,)),datetime.fromisoformat('2026-10-12T03:00:00+09:00'))
        self.assertEqual(snap['cutlines']['200']['actual_rank'],199)
        with self.assertRaises(ValueError):
            collect.make_snapshot('<h1>접속 제한</h1>',datetime.now(collect.KST))

    def test_retries_month_boundary_and_failure_preservation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for instant in ['2026-09-30T23:00:00+09:00','2026-10-01T00:00:00+09:00','2026-10-01T00:20:00+09:00']:
                collect.persist(root,'today',collect.make_snapshot(listing(),datetime.fromisoformat(instant)))
            # UTC date differs from KST date; late older observation cannot replace retry.
            collect.persist(root,'today',collect.make_snapshot(listing(),datetime.fromisoformat('2026-09-30T15:01:00+00:00')))
            data=collect.refresh_index(root)
            self.assertEqual(data['series']['today']['count'],2)
            self.assertEqual(data['series']['today']['latest']['timestamp'],'2026-10-01T00:20:00+09:00')
            path=root/'today'/'2026-10.json';before=path.read_bytes()
            collect.refresh_index(root,{'today':{'ok':False,'message':'test failure'}})
            self.assertEqual(path.read_bytes(),before)
            index=json.loads((root/'index.json').read_text(encoding='utf-8'))
            self.assertFalse(index['series']['today']['attempt']['ok'])


if __name__ == '__main__':
    unittest.main()
