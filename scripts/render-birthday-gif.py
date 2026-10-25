"""Build the small, self-hosted cake illustration used in birthday emails."""
from pathlib import Path
import math
import random
from PIL import Image, ImageDraw

OUTPUT = Path(__file__).resolve().parents[1] / "public/images/birthday-celebration-v1.gif"
WIDTH, HEIGHT, SCALE = 480, 190, 3
BACKGROUND = "#fff5dc"
random.seed(19)
confetti = [(random.randint(24, 456), random.randint(7, 170),
             random.choice(["#ba9be2", "#78c2ad", "#f0bd56", "#f2a2bd"]))
            for _ in range(30)]


def frame(index):
    image = Image.new("RGB", (WIDTH * SCALE, HEIGHT * SCALE), BACKGROUND)
    draw = ImageDraw.Draw(image)

    def rect(box, fill, radius=0):
        draw.rounded_rectangle(tuple(int(v * SCALE) for v in box), radius=radius * SCALE, fill=fill)

    def ellipse(box, fill):
        draw.ellipse(tuple(int(v * SCALE) for v in box), fill=fill)

    def line(points, fill, width=2):
        draw.line([(int(x * SCALE), int(y * SCALE)) for x, y in points], fill=fill, width=width * SCALE)

    for number, (x, y, colour) in enumerate(confetti):
        drift = math.sin(index * math.pi / 6 + number) * 3
        rect((x + drift, y, x + drift + 3, y + 6), colour, 1)

    # Flowers frame the cake, including a complete first frame for mail clients
    # that display only a still image.
    for x, y, colour in [(109, 115, "#f2a2bd"), (135, 137, "#b6a7df"),
                         (357, 114, "#f0bd56"), (333, 137, "#b6a7df")]:
        line([(x, y + 7), (x - 4, 168)], "#7da99a", 3)
        ellipse((x - 14, y + 20, x, y + 27), "#a3c9b7")
        for petal in range(5):
            angle = petal * 2 * math.pi / 5
            px, py = x + math.cos(angle) * 8, y + math.sin(angle) * 8
            ellipse((px - 6, py - 6, px + 6, py + 6), colour)
        ellipse((x - 4, y - 4, x + 4, y + 4), "#f4d99f")

    ellipse((155, 163, 325, 179), "#efdfbc")
    ellipse((153, 156, 327, 170), "#ffffff")
    rect((173, 100, 307, 159), "#f2a9bb", 10)
    rect((173, 116, 307, 126), "#f8dfdf", 0)
    rect((173, 143, 307, 151), "#e893ac", 0)
    rect((173, 93, 307, 111), "#fffafa", 9)
    for x in range(181, 301, 22):
        rect((x, 100, x + 10, 118 + (x % 3) * 3), "#fffafa", 5)
    for x, colour in [(211, "#9a8bcc"), (240, "#77b6a5"), (269, "#9a8bcc")]:
        rect((x - 3, 66, x + 3, 95), colour, 2)
        flicker = math.sin(index * math.pi / 6 + x) * 1.5
        ellipse((x - 5 + flicker, 48, x + 5 + flicker, 64), "#f0bd56")
        ellipse((x - 2 + flicker, 54, x + 2 + flicker, 63), "#fff3bf")
    return image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS).quantize(colors=96)


OUTPUT.parent.mkdir(parents=True, exist_ok=True)
frames = [frame(index) for index in range(12)]
frames[0].save(OUTPUT, save_all=True, append_images=frames[1:], duration=140, loop=0, disposal=2)
print(f"Generated {OUTPUT.name}: {OUTPUT.stat().st_size:,} bytes, {len(frames)} frames.")
