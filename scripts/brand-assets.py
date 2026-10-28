#!/usr/bin/env python3
"""
Generate the Checkrail Pay brand assets from one definition of the mark.

    pip install --target /tmp/brand-py fonttools brotli uharfbuzz   (any scratch folder, never the repo)
    PYTHONPATH=/tmp/brand-py python3 scripts/brand-assets.py        (needs Python Playwright with Chromium)

Writes:
    src/app/icon.svg                  favicon (follows the browser's light or dark scheme)
    src/app/apple-icon.png            180 x 180 home-screen icon
    src/app/opengraph-image.png       1200 x 630 social card (and its alt text)
    public/brand/checkrail-mark.svg   the mark alone, for README, video and slides
    public/brand/checkrail-lockup.svg mark plus wordmark, text converted to outlines
    site/brand/                       copies of the mark, the lockup and the social card (og.png) for the landing page

The mark is a short length of track seen from above: four ties (sleepers) in soft ink, two ink rails, a short
"check rail" laid inside the lower rail, and a settled-green tick where the track ends. The ties are what keep it
from reading as a "checklist done" icon at 16px; keep at least three of them. The same path data lives in
src/components/BrandMark.tsx; change both.
"""
import base64
import io
import shutil
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
import uharfbuzz as hb
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "src" / "app" / "fonts" / "archivo-variable.woff2"

INK, INK_DARK = "#10233A", "#E6ECF2"
INK_SOFT_DARK = "#93A3B4"
SETTLED, SETTLED_DARK = "#0E7C5B", "#3DB58F"
PAPER, SHEET, INK_SOFT, BLOCKED = "#EDF0F2", "#FFFFFF", "#5B6B7C", "#A8261D"

# 32 x 32 grid, round caps. Ties 2 units (soft ink), rails 2.75, check rail 2.25, tick 3 (settled).
TIES = ["M4.5 7V25", "M9.5 7V25", "M14.5 7V25", "M19.5 7V25"]
RAILS = ["M2 10.5H21.5", "M2 21.5H21.5"]
CHECK_RAIL = "M7 17.5H17"
TICK = "M22.5 17l2.5 3 5-6.5"


def mark_paths(ink: str, tick: str, soft: str = "", cls: bool = False) -> str:
    def a(c: str, col: str) -> str:
        return f' class="{c}"' if cls else f' stroke="{col}"'
    ties = "".join(f'<path{a("s", soft or INK_SOFT)} stroke-width="2" d="{d}"/>' for d in TIES)
    rails = "".join(f'<path{a("r", ink)} stroke-width="2.75" d="{d}"/>' for d in RAILS)
    check = f'<path{a("r", ink)} stroke-width="2.25" d="{CHECK_RAIL}"/>'
    return f'<g fill="none" stroke-linecap="round" stroke-linejoin="round">{ties}{rails}{check}<path{a("t", tick)} stroke-width="3" d="{TICK}"/></g>'


ADAPTIVE_STYLE = (
    f"<style>.r{{stroke:{INK}}}.s{{stroke:{INK_SOFT}}}.t{{stroke:{SETTLED}}}"
    f"@media (prefers-color-scheme:dark){{.r{{stroke:{INK_DARK}}}.s{{stroke:{INK_SOFT_DARK}}}.t{{stroke:{SETTLED_DARK}}}}}</style>"
)


def mark_svg(size: int = 32) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 32 32">'
        f"<title>Checkrail Pay</title>{ADAPTIVE_STYLE}{mark_paths('', '', cls=True)}</svg>\n"
    )


def wordmark_paths(text: str, px: float, letter_spacing_em: float = -0.02) -> tuple[str, float]:
    """Archivo at width 112, weight 600, shaped with HarfBuzz and converted to one SVG path. Returns (d, width)."""
    font = TTFont(str(FONT))
    inst = instantiateVariableFont(font, {"wght": 600, "wdth": 112})
    buf_ttf = io.BytesIO()
    inst.flavor = None
    inst.save(buf_ttf)
    data = buf_ttf.getvalue()
    face = hb.Face(data)
    hbfont = hb.Font(face)
    upem = face.upem
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hbfont, buf, {"kern": True, "liga": True})
    glyphset = inst.getGlyphSet()
    order = inst.getGlyphOrder()
    scale = px / upem
    x = 0.0
    ds = []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = order[info.codepoint]
        pen = SVGPathPen(glyphset)
        # Font units are y-up; SVG is y-down. Baseline sits at y = 0.
        tpen = TransformPen(pen, (scale, 0, 0, -scale, x + pos.x_offset * scale, -pos.y_offset * scale))
        glyphset[name].draw(tpen)
        ds.append(pen.getCommands())
        x += pos.x_advance * scale + letter_spacing_em * px
    width = x - letter_spacing_em * px
    return " ".join(d for d in ds if d), width


def lockup_svg() -> str:
    # Mark 40 high, wordmark 26px, baseline aligned to the lower rail.
    px = 26
    d, w = wordmark_paths("Checkrail Pay", px)
    mark_scale = 40 / 32
    gap = 10
    text_x = 40 + gap
    baseline = 30
    total_w = round(text_x + w + 2)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w}" height="40" viewBox="0 0 {total_w} 40">'
        f"<title>Checkrail Pay</title>"
        f"<style>.r{{stroke:{INK}}}.s{{stroke:{INK_SOFT}}}.t{{stroke:{SETTLED}}}.w{{fill:{INK}}}"
        f"@media (prefers-color-scheme:dark){{.r{{stroke:{INK_DARK}}}.s{{stroke:{INK_SOFT_DARK}}}.t{{stroke:{SETTLED_DARK}}}.w{{fill:{INK_DARK}}}}}</style>"
        f'<g transform="scale({mark_scale})">{mark_paths("", "", cls=True)}</g>'
        f'<path class="w" transform="translate({text_x} {baseline})" d="{d}"/></svg>\n'
    )


def font_face() -> str:
    b64 = base64.b64encode(FONT.read_bytes()).decode()
    return (
        "@font-face{font-family:Archivo;src:url(data:font/woff2;base64," + b64 + ") format('woff2');"
        "font-weight:100 900;font-stretch:62% 125%;}"
    )


def apple_icon_html() -> str:
    return (
        f"<html><body style='margin:0;width:180px;height:180px;background:{PAPER};display:flex;align-items:center;justify-content:center'>"
        f"<svg width='128' height='128' viewBox='0 0 32 32'>{mark_paths(INK, SETTLED)}</svg></body></html>"
    )


def og_html() -> str:
    stations = ["Read", "Verified", "Routed", "Paid", "Reconciled"]
    x0, x1 = 64, 1008  # inside the 1072 wide sheet
    xs = [x0 + (x1 - x0) * i / 4 for i in range(5)]
    ticks = "".join(f"<line x1='{x}' y1='66' x2='{x}' y2='82' stroke='{INK_SOFT}' stroke-opacity='0.5' stroke-width='2'/>" for x in xs[2:])
    labels = "".join(
        f"<text x='{x}' y='128' text-anchor='{'start' if i == 0 else 'end' if i == 4 else 'middle'}' "
        f"fill='{BLOCKED if i == 1 else INK_SOFT}' font-weight='{600 if i == 1 else 500}'>{s}</text>"
        for i, (x, s) in enumerate(zip(xs, stations))
    )
    bx = xs[1]
    line = (
        f"<svg width='1072' height='176' viewBox='0 0 1072 176' style='display:block;font-family:Archivo;font-stretch:88%;font-size:22px'>"
        f"<line x1='{x0}' y1='74' x2='{bx - 22}' y2='74' stroke='{INK}' stroke-width='4' stroke-linecap='round'/>"
        f"<line x1='{bx + 22}' y1='74' x2='{x1}' y2='74' stroke='{INK_SOFT}' stroke-opacity='0.5' stroke-width='2'/>"
        f"<circle cx='{x0}' cy='74' r='7' fill='{INK}'/>"
        f"{ticks}"
        f"<circle cx='{bx}' cy='74' r='19' fill='{SHEET}' stroke='{BLOCKED}' stroke-width='3'/>"
        f"<path d='M{bx - 7} 67l14 14M{bx + 7} 67l-14 14' stroke='{BLOCKED}' stroke-width='3.5' stroke-linecap='round'/>"
        f"{labels}"
        f"<text x='{bx}' y='158' text-anchor='middle' fill='{BLOCKED}' font-stretch='100%' font-size='20'>Asked USD 960, trip sheet says USD 800</text>"
        f"</svg>"
    )
    return f"""<html><head><style>{font_face()}
      body{{margin:0;width:1200px;height:630px;background:{PAPER};color:{INK};font-family:Archivo;overflow:hidden}}
      .wrap{{padding:64px 64px 0}}
      .lock{{display:flex;align-items:center;gap:20px}}
      .word{{font-stretch:112%;font-weight:600;letter-spacing:-0.02em;font-size:52px;line-height:1}}
      h1{{margin:44px 0 0;font-stretch:100%;font-weight:600;font-size:56px;line-height:64px;letter-spacing:-0.015em;max-width:960px}}
      .sheet{{position:absolute;left:64px;right:64px;bottom:56px;background:{SHEET};border:1px solid rgba(91,107,124,.24);border-radius:10px}}
    </style></head><body><div class="wrap">
      <div class="lock"><svg width="72" height="72" viewBox="0 0 32 32">{mark_paths(INK, SETTLED)}</svg><span class="word">Checkrail Pay</span></div>
      <h1>Checks every supplier payment before money moves.</h1>
    </div><div class="sheet">{line}</div></body></html>"""


def render(html: str, w: int, h: int, out: Path) -> None:
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
        page.set_content(html, wait_until="load")
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(200)
        page.screenshot(path=str(out), clip={"x": 0, "y": 0, "width": w, "height": h})
        b.close()


def main() -> None:
    (ROOT / "public" / "brand").mkdir(parents=True, exist_ok=True)
    (ROOT / "src" / "app" / "icon.svg").write_text(mark_svg())
    (ROOT / "public" / "brand" / "checkrail-mark.svg").write_text(mark_svg(256))
    (ROOT / "public" / "brand" / "checkrail-lockup.svg").write_text(lockup_svg())
    render(apple_icon_html(), 180, 180, ROOT / "src" / "app" / "apple-icon.png")
    render(og_html(), 1200, 630, ROOT / "src" / "app" / "opengraph-image.png")
    (ROOT / "src" / "app" / "opengraph-image.alt.txt").write_text(
        "Checkrail Pay: a payment line broken at Verified because the request asked USD 960 and the trip sheet says USD 800"
    )
    site = ROOT / "site" / "brand"
    site.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "public" / "brand" / "checkrail-mark.svg", site / "checkrail-mark.svg")
    shutil.copyfile(ROOT / "public" / "brand" / "checkrail-lockup.svg", site / "checkrail-lockup.svg")
    shutil.copyfile(ROOT / "src" / "app" / "opengraph-image.png", site / "og.png")
    print("wrote icon.svg, apple-icon.png, opengraph-image.png (and alt), public/brand/*.svg, site/brand/ copies")


if __name__ == "__main__":
    main()
