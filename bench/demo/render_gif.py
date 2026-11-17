"""Render docs/media/demo.gif from docs/media/demo-transcript.json (real proxy output).

Usage: python bench/demo/render_gif.py [--font PATH]
Needs Pillow. Every line drawn comes from the transcript; nothing is typed in by hand
except the captions and labels.
"""
import argparse
import json
import os
import sys
import textwrap

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TRANSCRIPT = os.path.join(ROOT, "docs", "media", "demo-transcript.json")
OUT = os.path.join(ROOT, "docs", "media", "demo.gif")

W, H = 1040, 500
PAD_X, TOP = 26, 58
SIZE = 16
LINE = 23
WRAP = 104

BG = (13, 17, 23)
BAR = (22, 27, 34)
FG = (201, 209, 217)
DIM = (125, 133, 144)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
YELLOW = (210, 153, 34)
BLUE = (88, 166, 255)
PURPLE = (188, 140, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\CascadiaMono.ttf",
    r"C:\Windows\Fonts\consola.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
]


def load_font(path, bold=False):
    candidates = [path] if path else FONT_CANDIDATES
    for c in candidates:
        if c and os.path.exists(c):
            return ImageFont.truetype(c, SIZE)
    sys.exit("No monospace font found; pass --font PATH")


class Screen:
    """A list of lines, each a list of (text, color) segments."""

    def __init__(self):
        self.lines = []

    def add(self, *segments):
        self.lines.append(list(segments))

    def blank(self):
        self.lines.append([])


def draw(screen, font, title):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 36], fill=BAR)
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + i * 22, 12, 28 + i * 22, 24], fill=color)
    tw = d.textlength(title, font=font)
    d.text(((W - tw) / 2, 9), title, font=font, fill=DIM)
    char_w = d.textlength("M", font=font)
    y = TOP
    for line in screen.lines[-((H - TOP - 10) // LINE):]:
        x = PAD_X
        for text, color in line:
            d.text((x, y), text, font=font, fill=color)
            x += char_w * len(text)
        y += LINE
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--font")
    args = ap.parse_args()
    font = load_font(args.font)
    data = json.load(open(TRANSCRIPT, encoding="utf-8"))
    title = "agent-brake: same agent, same tool calls, two configurations"

    frames, durations = [], []

    def snap(screen, ms):
        frames.append(draw(screen, font, title))
        durations.append(ms)

    # Intro
    s = Screen()
    s.blank()
    s.add(("  AgentBrake", BLUE), ("  MCP proxy that tracks where an agent's data goes", FG))
    s.blank()
    s.add(("  A prompt-injected agent makes the same tool calls twice:", DIM))
    s.add(("    allow-list + regex", FG), ("   (the usual setup)", DIM))
    s.add(("    AgentBrake        ", BLUE), ("   (typed path/URL rules + secret-flow tracking)", DIM))
    s.blank()
    s.add(("  Every line below is real output from the proxy (npm run gauntlet).", DIM))
    snap(s, 3200)

    n = len(data["scenes"])
    for idx, scene in enumerate(data["scenes"], 1):
        s = Screen()
        s.add((f"# {idx}/{n}  {scene['caption']}", PURPLE))
        s.blank()
        snap(s, 900)
        for step in scene["steps"]:
            s.add(("$ ", DIM), (step["tool"], FG), ("  " + step["args"], DIM))
            snap(s, 700)
            base, ab = step["baseline"], step["agentbrake"]
            if base:
                if base["forwarded"]:
                    s.add(("    allow-list + regex  ", DIM),
                          ("forwarded", RED if step["malicious"] else FG),
                          ("   <- attack succeeds" if step["malicious"] else "", RED))
                else:
                    s.add(("    allow-list + regex  ", DIM), ("blocked", GREEN))
            if ab:
                if ab["forwarded"]:
                    s.add(("    AgentBrake          ", BLUE), ("forwarded", FG))
                else:
                    msg = ab.get("message") or ""
                    label = "REFUSED (needs approval)" if "APPROVAL_REQUIRED" in msg else "BLOCKED"
                    s.add(("    AgentBrake          ", BLUE), (label, GREEN), (f"   by {ab['policy']}", DIM))
            snap(s, 900)
            if ab and ab.get("message"):
                for i, part in enumerate(textwrap.wrap(ab["message"], WRAP - 6)):
                    s.add(("    " + ("" if i == 0 else "  ") + part, YELLOW))
                snap(s, 3400)
        snap(s, 600)

    # Scoreboard
    sm = data["summary"]
    s = Screen()
    s.add(("# The Gauntlet: 21 scripted attacks, 10 benign tasks, real proxy, no model", PURPLE))
    s.blank()
    s.add(("                          attacks blocked     benign tasks refused", DIM))
    for key, color in (("none", FG), ("baseline", FG), ("agentbrake", BLUE)):
        r = sm[key]
        s.add((f"    {r['label']:<22}", color),
              (f"{r['attacksBlocked']:>2} / {r['attacks']}", GREEN if key == "agentbrake" else RED),
              (f"{'':>15}{r['falsePositives']} / {r['benign']}", FG))
    s.blank()
    s.add(("  The 3 misses are documented limits: a shell command uploading a file,", DIM))
    s.add(("  a paraphrase with no untrusted input, data drip-fed 8 characters at a time.", DIM))
    s.blank()
    s.add(("  ~0.1 ms added per call (p50).  github.com/Ujjwaljain16/AgentBrake", DIM))
    snap(s, 6000)

    # Palette-quantise each frame against one shared palette so colours do not flicker.
    sheet = Image.new("RGB", (W, H * len(frames)))
    for i, f in enumerate(frames):
        sheet.paste(f, (0, H * i))
    palette_src = sheet.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    quantized = [f.quantize(palette=palette_src, dither=Image.Dither.NONE) for f in frames]
    quantized[0].save(OUT, save_all=True, append_images=quantized[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"Wrote {os.path.relpath(OUT, ROOT)}: {len(frames)} frames, {sum(durations) / 1000:.1f}s, {os.path.getsize(OUT) // 1024} KiB")


if __name__ == "__main__":
    main()
