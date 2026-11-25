"""Offline raster baseline. Does not generate CAD geometry."""
import argparse
import csv
import io
import json
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

import fitz
import joblib
import numpy as np
from PIL import Image, ImageOps
from sklearn.model_selection import GroupShuffleSplit
from sklearn.neural_network import MLPRegressor


def ink(image):
    image = ImageOps.contain(image.convert('L'), (64, 64), Image.Resampling.LANCZOS)
    canvas = Image.new('L', (64, 64), 255)
    canvas.paste(image, ((64 - image.width) // 2, (64 - image.height) // 2))
    return (255 - np.asarray(canvas, dtype=np.float32)).flatten() / 255


def load(zip_path, index):
    inputs, targets, groups, pairs = [], [], [], []
    with ZipFile(zip_path, metadata_encoding='utf-8') as archive, open(index, encoding='utf-8-sig') as table:
        for row in csv.DictReader(table):
            if row['Проверка'] != 'Проверить соответствие по подъездам':
                continue
            pdf = row['PDF в ZIP']
            pages = [int(n) for n in row['Страницы эскизов (с 1)'].split(', ')]
            names = row['JPG в папке объекта'].split(', ')
            with fitz.open(stream=archive.read(pdf), filetype='pdf') as document:
                for page, name in zip(pages, names, strict=True):
                    pixmap = document[page - 1].get_pixmap(matrix=fitz.Matrix(0.6, 0.6), colorspace=fitz.csGRAY)
                    source = Image.frombytes('L', (pixmap.width, pixmap.height), pixmap.samples)
                    target_path = str(PurePosixPath(pdf).with_name(name))
                    with Image.open(io.BytesIO(archive.read(target_path))) as target:
                        targets.append(ink(ImageOps.exif_transpose(target)))
                    # The pilot assumes PDF pages and numbered JPGs follow the same order.
                    inputs.append(ink(source.rotate(90, expand=True) if source.height > source.width else source))
                    groups.append(row['Объект'])
                    pairs.append((pdf, page, target_path))
    return np.stack(inputs), np.stack(targets), np.asarray(groups), pairs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive')
    parser.add_argument('index')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    x, y, groups, pairs = load(args.archive, args.index)
    train, test = next(GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=42).split(x, y, groups))
    model = MLPRegressor(hidden_layer_sizes=(96,), max_iter=80, tol=1e-6, random_state=42)
    model.fit(x[train], y[train])
    pred = np.clip(model.predict(x[test]), 0, 1)
    mean = np.broadcast_to(y[train].mean(axis=0), pred.shape)
    def metrics(estimate):
        target_mask = y[test] >= 0.12
        mask = estimate >= 0.12
        return {
            'mse': float(np.mean((estimate - y[test]) ** 2)),
            'ink_f1': float(2 * np.count_nonzero(mask & target_mask) /
                            max(1, np.count_nonzero(mask) + np.count_nonzero(target_mask))),
        }
    args.output.mkdir(parents=True, exist_ok=True)
    result = {'train_pairs': len(train), 'test_pairs': len(test),
              'train_addresses': len(set(groups[train])), 'test_addresses': len(set(groups[test])),
              'iterations': model.n_iter_, 'mlp': metrics(pred), 'mean_baseline': metrics(mean)}
    (args.output / 'metrics.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    with (args.output / 'pairs.csv').open('w', newline='', encoding='utf-8-sig') as file:
        writer = csv.writer(file)
        writer.writerow(['pdf', 'page', 'jpg', 'split', 'match_basis'])
        held_out = set(test)
        writer.writerows((*pair, 'test' if i in held_out else 'train', 'pdf_page_order_assumption')
                         for i, pair in enumerate(pairs))
    joblib.dump(model, args.output / 'raster-pilot.joblib', compress=3)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
