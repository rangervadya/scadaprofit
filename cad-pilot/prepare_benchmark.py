"""Render the indexed customer sketch pages into a local benchmark workspace."""
import argparse
import csv
import json
from pathlib import Path, PurePosixPath

import fitz


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    args.output.mkdir(parents=True, exist_ok=False)
    images = args.output / 'images'
    images.mkdir()
    manifest = []
    with (root / 'cad-pilot' / 'pairs.csv').open(encoding='utf-8-sig') as pairs:
        for number, row in enumerate(csv.DictReader(pairs), 1):
            sketch = PurePosixPath(row['pdf'])
            target = PurePosixPath(row['jpg'])
            name = f'images/{number:03}.png'
            with fitz.open(root.joinpath(*sketch.parts[1:])) as document:
                document[int(row['page']) - 1].get_pixmap(dpi=144, alpha=False).save(args.output / name)
            manifest.append({
                'image': name, 'address': sketch.parent.name, 'split': row['split'],
                'pdf': str(sketch.relative_to(sketch.parts[0])), 'page': int(row['page']),
                'style_example': str(target.relative_to(target.parts[0])),
            })
    (args.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
