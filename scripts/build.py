"""Build a static/offline site without dependencies or network requests."""
import argparse
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def build(source, output):
    source, output = source.resolve(), output.resolve()
    if output == source or source in output.parents or output in source.parents:
        raise ValueError("출력 폴더는 소스 폴더 밖에 있어야 합니다.")
    output.mkdir(parents=True, exist_ok=True)
    for name in ["index.html", "app.js", "style.css", "config.js"]:
        shutil.copy2(source / name, output / name)
    shutil.copytree(source / "data", output / "data", dirs_exist_ok=True)
    # One small JS wrapper per month enables file:// use without a local server.
    for path in (output / "data").rglob("*.json"):
        value = json.loads(path.read_text(encoding="utf-8"))
        key = path.relative_to(output / "data").as_posix()
        path.with_suffix(".js").write_text("globalThis.MUNPIA_FILES = globalThis.MUNPIA_FILES || {};\nglobalThis.MUNPIA_FILES[" + json.dumps(key) + "] = " + json.dumps(value, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    (output / ".nojekyll").write_text("")
    print(f"사이트 파일 준비 완료: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT / "site")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    build(args.source, args.output)
