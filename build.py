#!/usr/bin/env python3
"""Inline every source file into the single distributable flow_workbench.html.

There is no bundler, minifier or transpiler: the shipped file is the source,
readable with View Source. Run `python3 build.py` after editing anything in src/.
"""
import pathlib, sys

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
read = lambda n: (SRC / n).read_text()


def build() -> str:
    ext = "\n".join(read(n) for n in ("svgctx.js", "project.js", "export.js", "free.js"))
    ui = read("ui.js").replace("/*__EXT__*/", ext)
    core = read("core.js").replace("</script", "<\\/script")
    return read("shell.html").replace("/*__CORE__*/", core).replace("/*__UI__*/", ui)


if __name__ == "__main__":
    html = build()
    for out in (ROOT / "dist" / "flow_workbench.html", ROOT / "docs" / "index.html"):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html)
    print(f"built {len(html):,} bytes -> dist/flow_workbench.html, docs/index.html")
    if "--check" in sys.argv:
        ref = (ROOT / "reference.html")
        if ref.exists() and ref.read_text() != html:
            sys.exit("build output differs from reference.html")
        print("matches reference")
