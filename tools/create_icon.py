"""Regenerate the application icon (build-time Pillow only)."""
from pathlib import Path
from PIL import Image, ImageDraw


def main():
    image = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((4, 4, 252, 252), radius=54, fill='#0b1728', outline='#19354b', width=3)
    draw.ellipse((42, 42, 214, 214), outline='#183e51', width=3)
    draw.ellipse((18, 72, 238, 184), outline='#20485c', width=2)
    nodes = [(128, 52), (203, 100), (180, 194), (57, 181), (46, 92)]
    for x, y in nodes:
        draw.line((128, 128, x, y), fill='#298eaa', width=4)
    for i, (x, y) in enumerate(nodes):
        color = '#f5bf69' if i == 0 else '#65e2eb'
        draw.ellipse((x - 10, y - 10, x + 10, y + 10), fill=color)
    draw.ellipse((102, 102, 154, 154), fill='#163c4c', outline='#7bf5d8', width=3)
    draw.ellipse((116, 116, 140, 140), fill='#7bf5d8')
    destination = Path(__file__).resolve().parent.parent / 'assets'
    destination.mkdir(exist_ok=True)
    image.save(str(destination / 'netspace.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('Created assets/netspace.ico')


if __name__ == '__main__':
    main()
