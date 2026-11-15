"""Pen-colour evidence for CAD edges.

Colour is measurement only. It never decides whether a stroke is an original
pipe or a later correction: inclusion stays with the geometry detector.
"""

from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np


def _annotate_edge_ink_color(edges: list[dict[str, Any]], blue_mask: np.ndarray, dark_mask: np.ndarray) -> dict[str, int]:
    """Attach measured pen-colour evidence without changing line inclusion.

    Blue and dark ink are evidence only: colour is not used to decide whether
    a stroke is an original pipe or a later correction.
    """
    if blue_mask.shape != dark_mask.shape:
        return {'classifiedBlue': 0, 'classifiedDark': 0, 'classifiedMixed': 0, 'unknown': len(edges)}
    blue = cv2.dilate(blue_mask, np.ones((3, 3), np.uint8), iterations=1) > 0
    dark_only_mask = cv2.bitwise_and(dark_mask, cv2.bitwise_not(blue_mask))
    dark = cv2.dilate(dark_only_mask, np.ones((3, 3), np.uint8), iterations=1) > 0
    height, width = blue.shape[:2]
    counts = {'classifiedBlue': 0, 'classifiedDark': 0, 'classifiedMixed': 0, 'unknown': 0}
    for edge in edges:
        samples: list[tuple[int, int]] = []
        geometry = edge.get('geometry') or []
        for start, end in zip(geometry, geometry[1:]):
            try:
                ax, ay, bx, by = float(start[0]), float(start[1]), float(end[0]), float(end[1])
            except (TypeError, ValueError, IndexError):
                continue
            length = math.hypot(bx - ax, by - ay)
            n = max(2, int(length / 3.0) + 1)
            for t in np.linspace(0.0, 1.0, n):
                x = min(width - 1, max(0, int(round(ax + (bx - ax) * t))))
                y = min(height - 1, max(0, int(round(ay + (by - ay) * t))))
                samples.append((x, y))
        if not samples:
            edge['inkColor'] = 'unknown'
            edge['inkColorConfidence'] = 0.0
            edge['inkColorEvidence'] = {'blueCoverage': 0.0, 'darkCoverage': 0.0, 'samples': 0}
            counts['unknown'] += 1
            continue
        blue_coverage = sum(bool(blue[y, x]) for x, y in samples) / len(samples)
        dark_coverage = sum(bool(dark[y, x]) for x, y in samples) / len(samples)
        if blue_coverage >= 0.40 and blue_coverage >= dark_coverage * 1.25:
            color = 'blue'
        elif dark_coverage >= 0.40 and dark_coverage >= blue_coverage * 1.25:
            color = 'dark'
        elif min(blue_coverage, dark_coverage) >= 0.20:
            color = 'mixed'
        else:
            color = 'unknown'
        confidence = abs(blue_coverage - dark_coverage) / max(blue_coverage, dark_coverage, 0.01)
        edge['inkColor'] = color
        edge['inkColorConfidence'] = round(confidence if color in {'blue', 'dark'} else 0.0, 3)
        edge['inkColorEvidence'] = {
            'blueCoverage': round(blue_coverage, 3),
            'darkCoverage': round(dark_coverage, 3),
            'samples': len(samples),
        }
        counts[{'blue': 'classifiedBlue', 'dark': 'classifiedDark', 'mixed': 'classifiedMixed'}.get(color, 'unknown')] += 1
    return counts
