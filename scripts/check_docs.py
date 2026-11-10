"""Fail if a doc is unreachable from the index files or a relative link is dead.

Every directory under docs/ has an index.md. Each index links every doc in its
directory and the index.md of every subdirectory, so the whole tree is
navigable from docs/index.md, which README.md links. Links into markdown files
are checked down to the anchor.
"""

import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
LINK = re.compile(r"\]\(([^)#\s]*)(#[^)\s]*)?\)")
HEADING = re.compile(r"^#{1,6} (.+)$", re.M)
FENCE = re.compile(r"^```.*?^```", re.M | re.S)
EXPLICIT = re.compile(r'<a id="([^"]+)"')


def slug(heading: str) -> str:
    text = re.sub(r"[^\w\- ]", "", heading.strip().lower())
    return text.replace(" ", "-")


def anchors(md: Path) -> set[str]:
    text = FENCE.sub("", md.read_text())
    return {slug(h) for h in HEADING.findall(text)} | set(EXPLICIT.findall(text))


def links(md: Path) -> set[Path]:
    found = set()
    for target, _ in LINK.findall(md.read_text()):
        if target and "://" not in target and not target.startswith("mailto:"):
            found.add((md.parent / unquote(target)).resolve())
    return found


def main() -> int:
    errors: list[str] = []

    if (DOCS / "index.md").resolve() not in links(ROOT / "README.md"):
        errors.append("README.md does not link docs/index.md")
    for directory in [DOCS, *sorted(p for p in DOCS.rglob("*") if p.is_dir())]:
        index = directory / "index.md"
        if not index.exists():
            errors.append(f"{directory.relative_to(ROOT)} has no index.md")
            continue
        linked = links(index)
        for doc in sorted(directory.glob("*.md")):
            if doc.name != "index.md" and doc.resolve() not in linked:
                errors.append(f"{index.relative_to(ROOT)} does not link {doc.name}")
        for sub in sorted(p for p in directory.iterdir() if p.is_dir()):
            if (sub / "index.md").resolve() not in linked:
                errors.append(f"{index.relative_to(ROOT)} does not link {sub.name}/index.md")

    for md in [*ROOT.glob("*.md"), *DOCS.rglob("*.md"), *(ROOT / "spec").rglob("*.md"), *(ROOT / "examples").glob("*.md")]:
        for target, anchor in LINK.findall(md.read_text()):
            if "://" in target or target.startswith("mailto:"):
                continue
            dest = (md.parent / unquote(target)).resolve() if target else md
            where = f"{md.relative_to(ROOT)}: {target}{anchor}"
            if not dest.exists():
                errors.append(f"{where}: dead link")
            elif anchor and dest.suffix == ".md" and anchor[1:] not in anchors(dest):
                errors.append(f"{where}: no such anchor")

    for err in errors:
        print(err, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
