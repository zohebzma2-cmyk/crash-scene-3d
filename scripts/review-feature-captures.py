"""Offline contact sheets and PDF rasterization for local visual audits."""
from pathlib import Path
import subprocess
import sys
from PIL import Image, ImageDraw

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'qa-output/road-features')
for folder in sorted(root.iterdir()):
    if not folder.is_dir():
        continue
    for pdf in folder.glob('*.pdf'):
        subprocess.run(['pdftoppm', '-r', '110', '-png', str(pdf), str(folder / 'pdf-page')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    panels = []
    for path in sorted(folder.glob('*.png')):
        im = Image.open(path).convert('RGB')
        im.thumbnail((600, 1500))
        panel = Image.new('RGB', (600, im.height + 28), 'white')
        panel.paste(im, (0, 28))
        ImageDraw.Draw(panel).text((5, 5), path.name, fill='black')
        panels.append(panel)
    for i in range(0, len(panels), 3):
        chunk = panels[i:i + 3]
        sheet = Image.new('RGB', (1800, max(p.height for p in chunk)), '#cccccc')
        for j, panel in enumerate(chunk):
            sheet.paste(panel, (j * 600, 0))
        sheet.save(folder / f'contact-{i // 3}.jpg')
print('Contact sheets include every PNG capture, PNG export and rasterized PDF page.')
