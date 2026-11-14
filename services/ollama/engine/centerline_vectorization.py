"""Source-faithful centerline vectorization for technical drawings.

Unlike contour tracing, this module thins source ink to one-pixel strokes and
exports open LWPOLYLINE entities.  It preserves the appearance of the drawing
without claiming that every stroke is a semantically verified pipe.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable

import numpy as np


@dataclass(frozen=True)
class CenterlineResult:
    svg: str
    dxf: str
    components: int
    paths: int
    vertices: int
    skeleton_pixels: int
    length_px: float
    page_width_mm: float
    page_height_mm: float


def zhang_suen_thinning(mask: np.ndarray, max_iterations: int = 128) -> np.ndarray:
    """Return a one-pixel-wide Zhang-Suen skeleton using NumPy only.

    The implementation intentionally has no scikit-image/opencv-contrib
    dependency, so the production Docker image needs only its existing NumPy
    and OpenCV packages.
    """
    image = (np.asarray(mask) > 0).astype(np.uint8)
    if image.ndim != 2:
        raise ValueError("Centerline tracing expects a single-channel mask")
    if image.size == 0:
        raise ValueError("Centerline tracing mask is empty")
    # A zero border prevents wraparound and lets the neighbourhood slices stay
    # aligned without special cases at the image edge.
    image = np.pad(image, 1, mode="constant")
    for _iteration in range(max(1, int(max_iterations))):
        changed = False
        for phase in (0, 1):
            p2 = image[:-2, 1:-1]
            p3 = image[:-2, 2:]
            p4 = image[1:-1, 2:]
            p5 = image[2:, 2:]
            p6 = image[2:, 1:-1]
            p7 = image[2:, :-2]
            p8 = image[1:-1, :-2]
            p9 = image[:-2, :-2]
            center = image[1:-1, 1:-1]
            neighbours = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
            sequence = (p2, p3, p4, p5, p6, p7, p8, p9, p2)
            transitions = np.zeros_like(center, dtype=np.uint8)
            for left, right in zip(sequence[:-1], sequence[1:]):
                transitions += ((left == 0) & (right == 1)).astype(np.uint8)
            condition = (
                (center == 1)
                & (neighbours >= 2)
                & (neighbours <= 6)
                & (transitions == 1)
            )
            if phase == 0:
                condition &= (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                condition &= (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            if np.any(condition):
                center[condition] = 0
                changed = True
        if not changed:
            break
    return image[1:-1, 1:-1].astype(np.uint8) * 255


def _pixel_graph(skeleton: np.ndarray):
    """Build an 8-neighbour graph without redundant diagonal shortcuts."""
    ys, xs = np.nonzero(skeleton)
    coords = [(int(x), int(y)) for y, x in zip(ys, xs)]
    coord_to_id = { (x, y): index for index, (x, y) in enumerate(coords) }
    adjacency: list[list[int]] = [[] for _ in coords]
    h, w = skeleton.shape
    offsets = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0),
               (-1, 1), (0, 1), (1, 1)]
    for index, (x, y) in enumerate(coords):
        neighbours = []
        for dx, dy in offsets:
            nx, ny = x + dx, y + dy
            other = coord_to_id.get((nx, ny))
            if other is None:
                continue
            # If an orthogonal pixel already bridges a diagonal, do not add a
            # second edge across the corner; it creates artificial triangles.
            if dx and dy and (skeleton[y, nx] > 0 or skeleton[ny, x] > 0):
                continue
            neighbours.append(other)
        adjacency[index] = neighbours
    return coords, adjacency


def _cluster_branch_pixels(coords: list[tuple[int, int]], adjacency: list[list[int]]) -> tuple[dict[int, int], dict[int, tuple[float, float]]]:
    """Cluster spatially adjacent endpoints/junction pixels into one CAD node.

    Clustering deliberately uses raw 8-neighbour proximity, not the pruned
    graph adjacency: redundant diagonal shortcuts are removed from line paths,
    but nearby junction pixels must still belong to the same CAD node.
    """
    branch_pixels = {index for index, neighbours in enumerate(adjacency) if len(neighbours) != 2}
    coord_to_id = {point: index for index, point in enumerate(coords)}
    cluster_of: dict[int, int] = {}
    centres: dict[int, tuple[float, float]] = {}
    next_cluster = 0
    for seed in branch_pixels:
        if seed in cluster_of:
            continue
        stack = [seed]
        members = []
        cluster_of[seed] = next_cluster
        while stack:
            current = stack.pop()
            members.append(current)
            x, y = coords[current]
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    other = coord_to_id.get((x + dx, y + dy))
                    if other in branch_pixels and other not in cluster_of:
                        cluster_of[other] = next_cluster
                        stack.append(other)
        # Store the node centroid; all incident open polylines share it so
        # their endpoints visibly meet in SVG and CAD.
        centres[next_cluster] = (float(np.mean([coords[current][0] for current in members])),
                                 float(np.mean([coords[current][1] for current in members])))
        next_cluster += 1
    return cluster_of, centres




def _edge_key(left: int, right: int) -> tuple[int, int]:
    return (left, right) if left < right else (right, left)


def _trace_paths(skeleton: np.ndarray, min_path_length: float) -> tuple[list[list[tuple[float, float]]], int, float]:
    coords, adjacency = _pixel_graph(skeleton)
    if not coords:
        return [], 0, 0.0
    degrees = [len(items) for items in adjacency]
    component_seen: set[int] = set()
    component_count = 0
    for seed in range(len(coords)):
        if seed in component_seen:
            continue
        component_count += 1
        stack = [seed]
        component_seen.add(seed)
        while stack:
            current = stack.pop()
            for other in adjacency[current]:
                if other not in component_seen:
                    component_seen.add(other)
                    stack.append(other)

    cluster_of, centres = _cluster_branch_pixels(coords, adjacency)
    visited: set[tuple[int, int]] = set()
    paths: list[list[tuple[float, float]]] = []
    total_length = 0.0

    def point_length(points: list[tuple[float, float]]) -> float:
        return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:]))

    # Trace every corridor between branch/end-point clusters. Each edge is
    # visited once; nodes are collapsed to shared centroids to close tiny gaps.
    for start, start_cluster in list(cluster_of.items()):
        for first in adjacency[start]:
            key = _edge_key(start, first)
            if key in visited or cluster_of.get(first) == start_cluster:
                continue
            visited.add(key)
            raw_points = [coords[start], coords[first]]
            previous, current = start, first
            end_cluster = None
            safety = 0
            while safety <= len(coords):
                safety += 1
                if current in cluster_of:
                    end_cluster = cluster_of[current]
                    break
                next_candidates = [item for item in adjacency[current] if item != previous]
                if not next_candidates:
                    break
                # A degree-two corridor has one forward neighbour. If a damaged
                # skeleton has a branch here, stop and let its cluster path be
                # represented independently rather than guessing a turn.
                following = next_candidates[0]
                edge = _edge_key(current, following)
                if edge in visited:
                    break
                visited.add(edge)
                raw_points.append(coords[following])
                previous, current = current, following
            if end_cluster is None:
                continue
            start_xy = centres[start_cluster]
            end_xy = centres[end_cluster]
            converted = [start_xy] + [(float(x), float(y)) for x, y in raw_points] + [end_xy]
            # Collapse consecutive duplicates, then simplify collinear pixel
            # stair-steps while retaining corners and branch attachment points.
            compact = [converted[0]]
            for point in converted[1:]:
                if math.hypot(point[0] - compact[-1][0], point[1] - compact[-1][1]) >= 0.35:
                    compact.append(point)
            if len(compact) < 2:
                continue
            length = point_length(compact)
            if length < min_path_length:
                continue
            paths.append(compact)
            total_length += length

    # Closed loops contain no degree-1/junction pixels. Trace their two-degree
    # connected components as one closed polyline instead of losing them.
    loop_seen: set[int] = set()
    for seed in range(len(coords)):
        if seed in cluster_of or seed in loop_seen or degrees[seed] != 2:
            continue
        stack = [seed]
        component = []
        loop_seen.add(seed)
        while stack:
            current = stack.pop()
            component.append(current)
            for other in adjacency[current]:
                if other not in loop_seen and other not in cluster_of:
                    loop_seen.add(other)
                    stack.append(other)
        if len(component) < 4:
            continue
        # A degree-two corridor that touches a branch/endpoint cluster is
        # already traced above. Only process components with no branch nodes
        # at all here; otherwise each open arm would be exported a second time.
        if any(neighbour in cluster_of for current in component for neighbour in adjacency[current]):
            continue
        first = component[0]
        neighbours = adjacency[first]
        if not neighbours:
            continue
        points = [coords[first]]
        previous, current = first, neighbours[0]
        visited_loop_edges = {_edge_key(first, current)}
        safety = 0
        while current != first and safety <= len(component) + 2:
            safety += 1
            points.append(coords[current])
            next_candidates = [item for item in adjacency[current] if item != previous]
            if not next_candidates:
                break
            following = next_candidates[0]
            key = _edge_key(current, following)
            if key in visited_loop_edges:
                break
            visited_loop_edges.add(key)
            previous, current = current, following
        if current == first:
            points.append(points[0])
        length = point_length([(float(x), float(y)) for x, y in points])
        if length >= min_path_length:
            paths.append([(float(x), float(y)) for x, y in points])
            total_length += length
    return paths, component_count, total_length


def _simplify_path(points: list[tuple[float, float]], tolerance: float = 0.65) -> list[tuple[float, float]]:
    """Ramer-Douglas-Peucker simplification with endpoints preserved."""
    if len(points) <= 2:
        return points
    start = np.array(points[0], dtype=np.float64)
    end = np.array(points[-1], dtype=np.float64)
    vector = end - start
    norm = float(np.linalg.norm(vector))
    if norm < 1e-9:
        pivot = max(range(1, len(points) - 1), key=lambda i: math.dist(points[0], points[i]))
        left = _simplify_path(points[:pivot + 1], tolerance)
        right = _simplify_path(points[pivot:], tolerance)
        return left[:-1] + right
    max_distance = -1.0
    max_index = -1
    for index in range(1, len(points) - 1):
        point = np.array(points[index], dtype=np.float64)
        offset = point - start
        distance = float(abs(vector[0] * offset[1] - vector[1] * offset[0]) / norm)
        if distance > max_distance:
            max_distance, max_index = distance, index
    if max_distance <= tolerance:
        return [points[0], points[-1]]
    left = _simplify_path(points[:max_index + 1], tolerance)
    right = _simplify_path(points[max_index:], tolerance)
    return left[:-1] + right


def _dxf_lwpolyline(layer: str, points: Iterable[tuple[float, float]],
                    scale: float, offset_x: float, offset_y: float,
                    page_height_mm: float, lineweight: int = 18) -> list[str]:
    converted = [(offset_x + x * scale, page_height_mm - (offset_y + y * scale)) for x, y in points]
    if len(converted) < 2:
        return []
    data = ["0", "LWPOLYLINE", "100", "AcDbEntity", "8", layer,
            "370", str(lineweight), "100", "AcDbPolyline",
            "90", str(len(converted)), "70", "0"]
    for x, y in converted:
        data.extend(["10", f"{x:.4f}", "20", f"{y:.4f}"])
    return data


def build_centerline_trace(mask: np.ndarray, *, source_name: str = "source",
                           page_width_mm: float | None = None,
                           page_height_mm: float | None = None,
                           min_path_length_px: float = 2.8,
                           simplify_tolerance_px: float = 0.65) -> CenterlineResult:
    """Trace source ink as open centreline paths for readable SVG/DXF output."""
    binary = (np.asarray(mask) > 0).astype(np.uint8) * 255
    if binary.ndim != 2:
        raise ValueError("Centerline tracing expects a single-channel mask")
    height, width = binary.shape
    if width < 2 or height < 2 or not np.any(binary):
        raise ValueError("Centerline tracing has no foreground pixels")
    skeleton = zhang_suen_thinning(binary)
    paths, components, total_length = _trace_paths(skeleton, max(0.0, float(min_path_length_px)))
    if not paths:
        raise ValueError("Centerline tracing found no usable open paths")

    if page_width_mm is None or page_height_mm is None:
        if width >= height:
            page_width_mm, page_height_mm = 297.0, 210.0
        else:
            page_width_mm, page_height_mm = 210.0, 297.0
    page_width_mm = float(page_width_mm)
    page_height_mm = float(page_height_mm)
    scale = min(page_width_mm / width, page_height_mm / height)
    offset_x = (page_width_mm - width * scale) / 2.0
    offset_y = (page_height_mm - height * scale) / 2.0

    svg_paths: list[str] = []
    dxf_entities: list[str] = []
    vertex_count = 0
    for index, raw_path in enumerate(paths, 1):
        path = _simplify_path(raw_path, max(0.0, float(simplify_tolerance_px)))
        if len(path) < 2:
            continue
        d = "M " + " L ".join(f"{x:.2f} {y:.2f}" for x, y in path)
        svg_paths.append(f'<path id="centerline-{index:05d}" d="{d}"/>')
        vertex_count += len(path)
        dxf_entities.extend(_dxf_lwpolyline(
            "SOURCE_CENTERLINE", path, scale, offset_x, offset_y,
            page_height_mm, lineweight=18
        ))

    safe_name = str(source_name or "source").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")[:180]
    svg = "\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{page_width_mm:g}mm" height="{page_height_mm:g}mm" viewBox="0 0 {width} {height}" preserveAspectRatio="xMidYMid meet">',
        f'<title>Линейная векторизация исходной схемы: {safe_name}</title>',
        f'<metadata>{len(paths)} open centerline paths; {vertex_count} vertices; source ink skeleton, not semantic pipe topology.</metadata>',
        f'<rect width="{width}" height="{height}" fill="#fff"/>',
        '<g id="SOURCE_CENTERLINE" fill="none" stroke="#111" stroke-width="0.78" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision">',
        *svg_paths,
        '</g>',
        '</svg>',
    ])

    dxf = [
        "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1021",
        "9", "$INSUNITS", "70", "4", "0", "ENDSEC",
        "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", "1",
        "0", "LAYER", "100", "AcDbSymbolTableRecord", "100", "AcDbLayerTableRecord",
        "2", "SOURCE_CENTERLINE", "70", "0", "62", "7", "6", "CONTINUOUS", "370", "18",
        "0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES",
        *dxf_entities,
        "0", "ENDSEC", "0", "EOF",
    ]
    return CenterlineResult(
        svg=svg + "\n", dxf="\n".join(dxf) + "\n",
        components=components, paths=len(svg_paths), vertices=vertex_count,
        skeleton_pixels=int(np.count_nonzero(skeleton)), length_px=float(total_length),
        page_width_mm=page_width_mm, page_height_mm=page_height_mm,
    )
