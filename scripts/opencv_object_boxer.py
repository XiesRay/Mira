#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OpenCV 独立物品框选工具
用途：
1. 在白板/海报图上手工框选“独立物品”
2. 自动生成 safe_bbox（带安全边距），避免动画裁切只显示一半
3. 导出 scene_boxes.json、预览图、每个物品裁剪图
4. 提供基于 OpenCV 的“候选框”作为辅助，但不强依赖自动识别

依赖:
    pip install opencv-python numpy

用法:
    python opencv_object_boxer.py input.png
    python opencv_object_boxer.py input.png --padding 56
    python opencv_object_boxer.py input.png --auto-json
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List, Tuple

import cv2
import numpy as np


BBox = Tuple[int, int, int, int]  # x, y, w, h
RegionCandidate = Tuple[int, np.ndarray, BBox, bool]
# 自动轮廓最多 16 点，低于编辑器上限，避免导入时再次简化。
MAX_POLYGON_POINTS = 16
CORNER_ROUNDING_RATIO = 0.03


@dataclass
class SelectedObject:
    id: str
    bbox: List[int]
    safe_bbox: List[int]
    center: List[float]
    bbox_norm: List[float]
    safe_bbox_norm: List[float]


def clamp_bbox(box: BBox, width: int, height: int) -> BBox:
    x, y, w, h = box
    x1 = max(0, min(width - 1, x))
    y1 = max(0, min(height - 1, y))
    x2 = max(x1 + 1, min(width, x + w))
    y2 = max(y1 + 1, min(height, y + h))
    return x1, y1, x2 - x1, y2 - y1


def expand_bbox(box: BBox, padding: int, width: int, height: int) -> BBox:
    x, y, w, h = box
    return clamp_bbox(
        (x - padding, y - padding, w + padding * 2, h + padding * 2),
        width,
        height,
    )


def box_area(box: BBox) -> int:
    return max(0, box[2]) * max(0, box[3])


def normalize_bbox(box: BBox, width: int, height: int) -> List[float]:
    x, y, w, h = box
    return [
        round(x / width, 6),
        round(y / height, 6),
        round(w / width, 6),
        round(h / height, 6),
    ]


def point_in_box(px: int, py: int, box: BBox) -> bool:
    x, y, w, h = box
    return x <= px <= x + w and y <= py <= y + h


def estimate_background_lab(image: np.ndarray) -> np.ndarray:
    """从四周边框估计背景颜色，适合深色白板图。"""
    return cv2.cvtColor(
        estimate_background_bgr(image).reshape(1, 1, 3),
        cv2.COLOR_BGR2LAB,
    ).reshape(3).astype(np.float32)


def estimate_background_bgr(image: np.ndarray) -> np.ndarray:
    """从四周边框估计背景 BGR 颜色。"""
    h, w = image.shape[:2]
    t = max(8, min(h, w) // 60)

    border = np.concatenate(
        [
            image[:t, :, :].reshape(-1, 3),
            image[-t:, :, :].reshape(-1, 3),
            image[:, :t, :].reshape(-1, 3),
            image[:, -t:, :].reshape(-1, 3),
        ],
        axis=0,
    )

    return np.median(border, axis=0).astype(np.uint8)


def fill_component_interiors(mask: np.ndarray) -> np.ndarray:
    """补齐封闭主体的内部，避免整页装饰边框吞掉其中的其他区域。"""
    filled = mask.copy()
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    for index, contour in enumerate(contours):
        if hierarchy[0, index, 3] == -1 and cv2.contourArea(contour) <= mask.size * 0.72:
            cv2.drawContours(filled, [contour], -1, 255, thickness=cv2.FILLED)
    return filled


def foreground_mask(
    image: np.ndarray,
    color_distance_threshold: float = 14.0,
) -> np.ndarray:
    """返回包含抗锯齿边缘的前景掩码，并适应大范围平滑背景渐变。"""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg = estimate_background_lab(image)
    dist = np.linalg.norm(lab - bg[None, None, :], axis=2)
    height, width = dist.shape
    border_width = max(8, min(height, width) // 60)
    border_distances = np.concatenate([
        dist[:border_width, :].reshape(-1),
        dist[-border_width:, :].reshape(-1),
        dist[:, :border_width].reshape(-1),
        dist[:, -border_width:].reshape(-1),
    ])
    adaptive_threshold = max(
        color_distance_threshold,
        min(
            42.0,
            max(
                float(np.percentile(dist, 75)) + 8.0,
                float(np.percentile(border_distances, 99)) + 8.0,
            ),
        ),
    )
    # 全局色差区分内容颜色，局部对比排除渐变和纸张底纹；保留低色差描边。
    local_background = cv2.GaussianBlur(lab, (0, 0), max(1.0, min(height, width) * 0.003))
    detail = np.linalg.norm(lab - local_background, axis=2)
    mask = (
        ((dist > adaptive_threshold) & (detail > 2.5))
        | ((dist > color_distance_threshold) & (detail > 6.0))
    ).astype(np.uint8) * 255
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    )
    return fill_component_interiors(mask)


def boundary_obstacle_mask(image: np.ndarray, target_mask: np.ndarray) -> np.ndarray:
    """为选区边线保留弱描边和抗锯齿像素，不改变候选目标本身。"""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg = estimate_background_lab(image)
    dist = np.linalg.norm(lab - bg[None, None, :], axis=2)
    height, width = dist.shape
    local_background = cv2.GaussianBlur(lab, (0, 0), max(1.0, min(height, width) * 0.003))
    detail = np.linalg.norm(lab - local_background, axis=2)
    radius = max(3, min(8, int(np.ceil(min(width, height) * 0.004))))
    nearby = cv2.dilate(
        target_mask,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2),
    )
    # 弱像素需要局部对比和强前景支持，不能让大面积背景色差封死所有边界。
    sensitive_mask = ((dist > 6.0) & (detail > 2.5) & (nearby > 0)).astype(np.uint8) * 255
    # 避障掩码不能再闭合：这会凭空填掉相邻主体之间仅有的背景缝隙。
    return cv2.bitwise_or(target_mask, sensitive_mask)


def adaptive_padding_steps(box: BBox, width: int, height: int) -> List[int]:
    """按画布和候选主体尺度给边线留出可分辨的安全距离。"""
    canvas_size = min(width, height)
    object_size = min(box[2], box[3])
    base = max(
        6,
        int(round(canvas_size * 0.008)),
        int(round(object_size * 0.018)),
    )
    maximum = max(base, int(round(canvas_size * 0.08)))
    return list(dict.fromkeys(
        min(maximum, max(base, int(round(base * factor))))
        for factor in (1.0, 1.5, 2.2, 3.2, 4.8)
    ))


def boundary_clearance(width: int, height: int) -> int:
    """按原图尺度留白，并额外预留 1px 给轮廓圆角和坐标取整。"""
    return max(3, int(np.ceil(min(width, height) * 0.003))) + 1


def restore_target_edges(
    source_mask: np.ndarray,
    foreground: np.ndarray,
    obstacle_mask: np.ndarray,
    box: BBox,
) -> np.ndarray:
    """只补回主体近邻内与其连通的弱边缘，不跨过其他强前景。"""
    height, width = source_mask.shape
    radius = max(3, min(8, int(np.ceil(min(width, height) * 0.004)))) + 1
    x, y, box_width, box_height = expand_bbox(box, radius, width, height)
    region = np.s_[y : y + box_height, x : x + box_width]
    source = source_mask[region]
    strong = foreground[region]
    # 使用真实笔画作种子，避免从形态学闭合或人工连接线吸收相邻文字。
    seeds = (source > 0) & (strong > 0)
    if not np.any(seeds):
        return source_mask
    nearby = cv2.dilate(
        seeds.astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2),
    )
    eligible = (
        (obstacle_mask[region] > 0)
        & (nearby > 0)
        & ((strong == 0) | (source > 0))
    ).astype(np.uint8)
    _, labels = cv2.connectedComponents(eligible, connectivity=8)
    target_labels = np.unique(labels[seeds])
    target_labels = target_labels[target_labels != 0]
    restored = source_mask.copy()
    restored[region] = np.where(np.isin(labels, target_labels), 255, source)
    return restored


def mask_bbox(mask: np.ndarray) -> BBox | None:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    x1 = int(xs.min())
    y1 = int(ys.min())
    x2 = int(xs.max()) + 1
    y2 = int(ys.max()) + 1
    return x1, y1, x2 - x1, y2 - y1


def split_merged_component(
    component_mask: np.ndarray,
    foreground: np.ndarray,
    width: int,
    height: int,
    depth: int = 0,
    split_axis: int | None = None,
) -> List[Tuple[np.ndarray, BBox, bool]]:
    """沿主体之间的空白通道递归拆分形态学粘连的超大分量。

    只在包围盒具有明显横向或纵向延展时尝试拆分；判断依据是前景投影
    的相对谷值和连续空白，不切断真实笔画或连接线。
    """
    box = mask_bbox(component_mask)
    if box is None:
        return []
    x, y, box_width, box_height = box
    canvas_area = width * height
    if depth >= 5 or box_area(box) / canvas_area < 0.08:
        return [(component_mask, box, depth > 0)]

    if split_axis is None and box_width >= box_height * 1.35:
        if box_height < height * 0.18:
            return [(component_mask, box, depth > 0)]
        axis = 0
        axis_length = box_width
    elif split_axis is None and box_height >= box_width * 1.35:
        if box_width < width * 0.18:
            return [(component_mask, box, depth > 0)]
        axis = 1
        axis_length = box_height
    elif split_axis == 0 and box_width >= box_height * 1.15:
        axis = 0
        axis_length = box_width
    elif split_axis == 1 and box_height >= box_width * 1.15:
        axis = 1
        axis_length = box_height
    else:
        return [(component_mask, box, depth > 0)]

    region = foreground[y : y + box_height, x : x + box_width] > 0
    projection = region.mean(axis=axis)
    smooth_width = max(5, int(round(axis_length * 0.025)))
    if smooth_width % 2 == 0:
        smooth_width += 1
    smoothed = np.convolve(
        projection,
        np.ones(smooth_width, dtype=np.float32) / smooth_width,
        mode="same",
    )
    search_start = max(1, int(round(axis_length * 0.2)))
    search_end = min(axis_length - 1, int(round(axis_length * 0.8)))
    if search_end <= search_start:
        return [(component_mask, box, depth > 0)]

    cut = int(np.argmin(smoothed[search_start:search_end])) + search_start
    left_peak = float(np.percentile(smoothed[:cut], 85)) if cut > 0 else 0
    right_peak = float(np.percentile(smoothed[cut:], 85)) if cut < axis_length else 0
    valley_ratio = float(smoothed[cut]) / max(1e-6, min(left_peak, right_peak))
    if min(left_peak, right_peak) <= 0 or valley_ratio > 0.48:
        return [(component_mask, box, depth > 0)]

    # 密度低仍可能是物品内部，只有足够宽的真实空白才允许切分。
    channel_width = boundary_clearance(width, height) * 2 + 3
    if axis_length < channel_width:
        return [(component_mask, box, depth > 0)]
    empty_channels = np.convolve(
        (projection == 0).astype(np.int32),
        np.ones(channel_width, dtype=np.int32),
        mode="valid",
    )
    safe_cuts = np.flatnonzero(empty_channels == channel_width) + channel_width // 2
    safe_cuts = safe_cuts[(safe_cuts >= search_start) & (safe_cuts < search_end)]
    if len(safe_cuts) == 0:
        return [(component_mask, box, depth > 0)]
    cut = int(safe_cuts[np.argmin(np.abs(safe_cuts - cut))])

    absolute_cut = x + cut if axis == 0 else y + cut
    first = component_mask.copy()
    second = component_mask.copy()
    if axis == 0:
        first[:, absolute_cut:] = 0
        second[:, :absolute_cut] = 0
    else:
        first[absolute_cut:, :] = 0
        second[:absolute_cut, :] = 0

    source_pixels = int(np.count_nonzero(component_mask))
    minimum_pixels = max(80, int(round(source_pixels * 0.12)))
    if (
        np.count_nonzero(first) < minimum_pixels
        or np.count_nonzero(second) < minimum_pixels
    ):
        return [(component_mask, box, depth > 0)]

    first_parts = split_merged_component(
        first,
        foreground,
        width,
        height,
        depth + 1,
        axis,
    )
    second_parts = split_merged_component(
        second,
        foreground,
        width,
        height,
        depth + 1,
        axis,
    )
    return first_parts + second_parts


def box_gap_score(left: BBox, right: BBox, width: int, height: int) -> float:
    """用归一化边缘距离寻找小区域最近的主区域。"""
    gap_x = max(
        0,
        max(left[0], right[0])
        - min(left[0] + left[2], right[0] + right[2]),
    )
    gap_y = max(
        0,
        max(left[1], right[1])
        - min(left[1] + left[3], right[1] + right[3]),
    )
    left_center = (left[0] + left[2] / 2, left[1] + left[3] / 2)
    right_center = (right[0] + right[2] / 2, right[1] + right[3] / 2)
    center_distance = np.hypot(
        (left_center[0] - right_center[0]) / width,
        (left_center[1] - right_center[1]) / height,
    )
    return float(np.hypot(gap_x / width, gap_y / height) + center_distance * 0.05)


def box_intersection_area(left: BBox, right: BBox) -> int:
    x1 = max(left[0], right[0])
    y1 = max(left[1], right[1])
    x2 = min(left[0] + left[2], right[0] + right[2])
    y2 = min(left[1] + left[3], right[1] + right[3])
    return max(0, x2 - x1) * max(0, y2 - y1)


def merge_region_candidates(left: RegionCandidate, right: RegionCandidate) -> RegionCandidate:
    """合并内容和包围盒，不绘制可能跨过其他主体的人工连接线。"""
    a, b = left[2], right[2]
    x, y = min(a[0], b[0]), min(a[1], b[1])
    x2, y2 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
    return left[0] + right[0], cv2.bitwise_or(left[1], right[1]), (x, y, x2 - x, y2 - y), True


def grouping_area(box: BBox) -> int:
    """限制细长线条的有效面积，避免仅因长度大就成为独立主体。"""
    return min(box_area(box), min(box[2], box[3]) ** 2 * 8)


def merge_small_components(
    candidates: List[RegionCandidate],
    width: int,
    height: int,
    minimum_area_ratio: float,
    preferred_count: int | None,
) -> List[RegionCandidate]:
    """先聚合同一行的小块，再把低于面积门槛的碎片归入附近主体。"""
    if len(candidates) < 2:
        return candidates

    canvas_area = width * height
    ordered = sorted(candidates, key=lambda item: box_area(item[2]), reverse=True)
    subsidiary_indexes = set()
    for index, candidate in enumerate(ordered):
        candidate_area = box_area(candidate[2])
        for larger in ordered[:index]:
            larger_area = box_area(larger[2])
            if candidate_area > larger_area * 0.45:
                continue
            covered_ratio = box_intersection_area(candidate[2], larger[2]) / candidate_area
            if covered_ratio >= 0.8:
                subsidiary_indexes.add(index)
                break

    anchor_indexes = {
        index
        for index, candidate in enumerate(ordered)
        if index not in subsidiary_indexes
        and grouping_area(candidate[2]) / canvas_area >= minimum_area_ratio
    }
    # 数量偏好不能把未达到面积门槛的单个字符重新提升成独立主体。
    anchors: List[RegionCandidate] = [
        (pixels, component_mask.copy(), box, was_split)
        for index, (pixels, component_mask, box, was_split) in enumerate(ordered)
        if index in anchor_indexes
    ]
    small = [
        candidate
        for index, candidate in enumerate(ordered)
        if index not in anchor_indexes and index not in subsidiary_indexes
    ]
    attached = [ordered[index] for index in sorted(subsidiary_indexes)]
    parents = list(range(len(small)))

    def root(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for first, candidate in enumerate(small):
        a = candidate[2]
        for second in range(first + 1, len(small)):
            b = small[second][2]
            overlap_y = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
            gap_x = max(0, max(a[0], b[0]) - min(a[0] + a[2], b[0] + b[2]))
            if (
                overlap_y >= min(a[3], b[3]) * 0.5
                and gap_x <= max(min(width, height) * 0.01, min(a[3], b[3]) * 0.75)
            ):
                parents[root(second)] = root(first)

    clusters: dict[int, RegionCandidate] = {}
    for index, candidate in enumerate(small):
        key = root(index)
        clusters[key] = merge_region_candidates(clusters[key], candidate) if key in clusters else candidate
    for candidate in clusters.values():
        if grouping_area(candidate[2]) / canvas_area >= minimum_area_ratio:
            anchors.append(candidate)
        else:
            attached.append(candidate)
    if not anchors:
        attached.sort(key=lambda candidate: box_area(candidate[2]), reverse=True)
        anchors.append(attached.pop(0))

    # 固定原始主体位置，避免合并后的大框继续级联吸收另一个完整主体。
    anchor_boxes = [candidate[2] for candidate in anchors]
    for candidate in attached:
        target_index = min(
            range(len(anchors)),
            key=lambda index: box_gap_score(candidate[2], anchor_boxes[index], width, height),
        )
        anchors[target_index] = merge_region_candidates(anchors[target_index], candidate)

    return sorted(anchors, key=lambda item: item[0], reverse=True)


def sort_regions_top_then_left(
    detected: List[Tuple[BBox, dict]],
    canvas_height: int,
) -> List[Tuple[BBox, dict]]:
    """先按纵向分层，再在同一层内从左到右排序。"""
    rows: List[List[Tuple[BBox, dict]]] = []
    by_vertical_center = sorted(
        detected,
        key=lambda item: (item[0][1] + item[0][3] / 2, item[0][0]),
    )
    for candidate in by_vertical_center:
        box = candidate[0]
        center_y = box[1] + box[3] / 2
        matching_row: List[Tuple[BBox, dict]] | None = None
        matching_distance = float("inf")
        for row in rows:
            row_center = float(np.median([
                item[0][1] + item[0][3] / 2 for item in row
            ]))
            row_height = float(np.median([item[0][3] for item in row]))
            tolerance = max(canvas_height * 0.035, min(box[3], row_height) * 0.38)
            distance = abs(center_y - row_center)
            if distance <= tolerance and distance < matching_distance:
                matching_row = row
                matching_distance = distance
        if matching_row is None:
            rows.append([candidate])
        else:
            matching_row.append(candidate)

    rows.sort(key=lambda row: float(np.median([
        item[0][1] + item[0][3] / 2 for item in row
    ])))
    return [
        candidate
        for row in rows
        for candidate in sorted(row, key=lambda item: (item[0][0], item[0][1]))
    ]


def fit_bbox_to_foreground(
    box: BBox,
    mask: np.ndarray,
    width: int,
    height: int,
    search_margin: int = 28,
    content_padding: int = 20,
) -> BBox:
    """加入留白后逐边外扩，直到边带没有前景或到达画布边缘。"""
    fitted = expand_bbox(box, max(0, content_padding), width, height)
    edge_band = max(8, content_padding)
    search_margin = max(1, search_margin)

    while True:
        x, y, w, h = fitted
        region = mask[y : y + h, x : x + w]
        if region.size == 0:
            break

        expand_left = x > 0 and np.any(region[:, : min(edge_band, w)])
        expand_right = x + w < width and np.any(region[:, max(0, w - edge_band) :])
        expand_top = y > 0 and np.any(region[: min(edge_band, h), :])
        expand_bottom = y + h < height and np.any(region[max(0, h - edge_band) :, :])

        if not any((expand_left, expand_right, expand_top, expand_bottom)):
            break

        x1 = x - search_margin if expand_left else x
        y1 = y - search_margin if expand_top else y
        x2 = x + w + search_margin if expand_right else x + w
        y2 = y + h + search_margin if expand_bottom else y + h
        fitted = clamp_bbox((x1, y1, x2 - x1, y2 - y1), width, height)

    return fitted


def extract_padded_crop(
    image: np.ndarray,
    box: BBox,
    padding: int,
    background_bgr: np.ndarray,
) -> np.ndarray:
    """即使物品靠近画布边缘，也在导出图四周补足完整背景边距。"""
    x, y, w, h = box
    crop = np.empty((h + padding * 2, w + padding * 2, 3), dtype=np.uint8)
    crop[:] = background_bgr

    wanted_x1 = x - padding
    wanted_y1 = y - padding
    wanted_x2 = x + w + padding
    wanted_y2 = y + h + padding
    src_x1 = max(0, wanted_x1)
    src_y1 = max(0, wanted_y1)
    src_x2 = min(image.shape[1], wanted_x2)
    src_y2 = min(image.shape[0], wanted_y2)
    dst_x1 = src_x1 - wanted_x1
    dst_y1 = src_y1 - wanted_y1
    crop[
        dst_y1 : dst_y1 + (src_y2 - src_y1),
        dst_x1 : dst_x1 + (src_x2 - src_x1),
    ] = image[src_y1:src_y2, src_x1:src_x2]
    return crop


def auto_proposals(
    image: np.ndarray,
    color_distance_threshold: float = 14.0,
    min_component_area: int = 100,
    min_side: int = 10,
) -> List[BBox]:
    """
    OpenCV 候选框：
    - 用边框估计深色背景
    - Lab 色差找出“非背景”笔画
    - 形态学连接邻近笔画
    - 连通域生成候选框

    注意：OpenCV 不理解“这是书/盾牌/文字”，所以这里只做候选，不自动当最终结果。
    """
    h, w = image.shape[:2]
    mask = foreground_mask(image, color_distance_threshold)
    k2 = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k2, iterations=1)

    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    boxes: List[BBox] = []

    for i in range(1, n):
        x, y, bw, bh, area = stats[i].tolist()

        if area < min_component_area:
            continue
        if bw < min_side or bh < min_side:
            continue
        if bw > w * 0.92 and bh > h * 0.92:
            continue

        boxes.append(expand_bbox((x, y, bw, bh), 18, w, h))

    boxes.sort(key=box_area, reverse=True)
    return boxes


def rounded_polygon_outline(polygon: np.ndarray) -> np.ndarray:
    """按前端的 3% 二次圆角采样，仅用于检查，不增加导出的控制点。"""
    points = polygon.astype(np.float64)
    starts = points + (np.roll(points, 1, axis=0) - points) * CORNER_ROUNDING_RATIO
    ends = points + (np.roll(points, -1, axis=0) - points) * CORNER_ROUNDING_RATIO
    amounts = np.linspace(0.0, 1.0, 7)[None, :, None]
    samples = (
        (1 - amounts) ** 2 * starts[:, None, :]
        + 2 * (1 - amounts) * amounts * points[:, None, :]
        + amounts ** 2 * ends[:, None, :]
    )
    return np.rint(samples.reshape(-1, 2)).astype(np.int32)


def polygon_is_simple(polygon: np.ndarray) -> bool:
    """拒绝重复点和自交，防止前端清洗时把轮廓改成未经避障的矩形。"""
    points = [tuple(map(int, point)) for point in polygon]
    if len(points) < 3 or len(set(points)) != len(points):
        return False
    if cv2.contourArea(polygon.reshape(-1, 1, 2)) == 0:
        return False

    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    for first, a in enumerate(points):
        b = points[(first + 1) % len(points)]
        for second in range(first + 1, len(points)):
            if second == first + 1 or (first == 0 and second == len(points) - 1):
                continue
            c = points[second]
            d = points[(second + 1) % len(points)]
            if (
                max(a[0], b[0]) < min(c[0], d[0])
                or max(c[0], d[0]) < min(a[0], b[0])
                or max(a[1], b[1]) < min(c[1], d[1])
                or max(c[1], d[1]) < min(a[1], b[1])
            ):
                continue
            if cross(a, b, c) * cross(a, b, d) <= 0 and cross(c, d, a) * cross(c, d, b) <= 0:
                return False
    return True


def polygon_is_safe(
    polygon: np.ndarray,
    source_mask: np.ndarray,
    foreground_mask_image: np.ndarray,
    smooth_corners: bool = False,
    clearance: int | None = None,
) -> bool:
    """确认完整包含目标，且边线与全图前景保持按画布尺度计算的距离。"""
    if not polygon_is_simple(polygon):
        return False
    outline = rounded_polygon_outline(polygon) if smooth_corners else polygon
    filled = np.zeros_like(source_mask)
    cv2.fillPoly(filled, [outline.reshape(-1, 1, 2)], 255)
    if not np.any(source_mask) or np.any((source_mask > 0) & (filled == 0)):
        return False

    height, width = source_mask.shape
    clearance = boundary_clearance(width, height) if clearance is None else clearance
    boundary = np.zeros_like(source_mask)
    cv2.polylines(
        boundary, [outline.reshape(-1, 1, 2)], True, 255,
        thickness=clearance * 2 + 1,
    )
    return not np.any(
        (boundary > 0) & ((foreground_mask_image > 0) | (source_mask > 0))
    )


def polygon_region_from_mask(
    source_mask: np.ndarray,
    width: int,
    height: int,
    padding: int,
    obstacle_mask: np.ndarray | None = None,
    clearance: int | None = None,
) -> dict | None:
    """沿目标生成轮廓，并保证边线不接触全图中的任何前景。"""
    source_box = mask_bbox(source_mask)
    if source_box is None:
        return None
    clearance = boundary_clearance(width, height) if clearance is None else clearance
    # 掩码运算只扫描候选及其最大扩张范围，保留邻近障碍所需的边带。
    offset_x, offset_y, roi_width, roi_height = expand_bbox(
        source_box, padding + clearance + 2, width, height,
    )
    roi = np.s_[offset_y : offset_y + roi_height, offset_x : offset_x + roi_width]
    target = source_mask[roi]
    foreground = obstacle_mask[roi] if obstacle_mask is not None else target
    candidate = cv2.dilate(
        target,
        cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (padding * 2 + 1, padding * 2 + 1),
        ),
        iterations=1,
    )
    if obstacle_mask is not None:
        other_foreground = foreground.copy()
        other_foreground[target > 0] = 0
        blocked = cv2.dilate(
            other_foreground,
            cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE,
                (clearance * 2 + 3,) * 2,
            ),
            iterations=1,
        )
        candidate[(blocked > 0) & (target == 0)] = 0
        candidate[target > 0] = 255
    ys, xs = np.nonzero(candidate)
    if len(xs) < 20:
        return None

    contours, _ = cv2.findContours(candidate, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    outline = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(outline, True)
    polygon: np.ndarray | None = None
    # 先尝试少点数的外轮廓。凹凸笔画无需逐点描摹，保留整个区域更重要。
    for ratio in (0.012, 0.008, 0.005, 0.003, 0.02, 0.03, 0.05):
        candidate_polygon = cv2.approxPolyDP(
            outline,
            max(1.0, perimeter * ratio),
            True,
        ).reshape(-1, 2)
        if not 4 <= len(candidate_polygon) <= MAX_POLYGON_POINTS:
            continue
        if polygon_is_safe(
            candidate_polygon, target, foreground,
            smooth_corners=True, clearance=clearance,
        ):
            polygon = candidate_polygon
            break
    if polygon is None:
        return None

    polygon = polygon + np.asarray([offset_x, offset_y], dtype=np.int32)
    x1 = int(polygon[:, 0].min())
    y1 = int(polygon[:, 1].min())
    x2 = int(polygon[:, 0].max())
    y2 = int(polygon[:, 1].max())
    return {
        "rect": {
            "x": round(x1 / width, 6),
            "y": round(y1 / height, 6),
            "width": round((x2 - x1 + 1) / width, 6),
            "height": round((y2 - y1 + 1) / height, 6),
        },
        "selectionType": "freehand",
        "points": [
            {
                "x": round(int(point[0]) / width, 6),
                "y": round(int(point[1]) / height, 6),
            }
            for point in polygon
        ],
    }


def safe_rectangle_region_from_mask(
    source_mask: np.ndarray,
    foreground_mask_image: np.ndarray,
    box: BBox,
    width: int,
    height: int,
    clearance: int | None = None,
) -> dict | None:
    """四条边各自寻找背景空隙，避免统一外扩后碰到另一侧的邻居。"""
    clearance = boundary_clearance(width, height) if clearance is None else clearance
    padding_steps = adaptive_padding_steps(box, width, height)
    canvas_width, canvas_height = width, height
    offset_x, offset_y, width, height = expand_bbox(
        box, padding_steps[-1] + clearance + 2, width, height,
    )
    roi = np.s_[offset_y : offset_y + height, offset_x : offset_x + width]
    source_mask = source_mask[roi]
    foreground_mask_image = foreground_mask_image[roi]
    box = (box[0] - offset_x, box[1] - offset_y, box[2], box[3])
    occupied = cv2.dilate(
        cv2.bitwise_or(source_mask, foreground_mask_image),
        cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            ((clearance * 2 + 3) if clearance > 0 else 1,) * 2,
        ),
    ) > 0
    x, y, box_width, box_height = box
    right, bottom = x + box_width - 1, y + box_height - 1
    maximum = padding_steps[-1]
    preferred = padding_steps[0]
    bounds = [
        (max(0, x - maximum), x, x - preferred),
        (max(0, y - maximum), y, y - preferred),
        (right, min(width - 1, right + maximum), right + preferred),
        (bottom, min(height - 1, bottom + maximum), bottom + preferred),
    ]
    edges = [x, y, right, bottom]
    candidates: List[BBox] = []
    for _ in range(4):
        for side, (start, end, ideal) in enumerate(bounds):
            positions = np.arange(start, end + 1)
            if side in (0, 2):
                costs = np.count_nonzero(occupied[edges[1] : edges[3] + 1, start : end + 1], axis=0)
            else:
                costs = np.count_nonzero(occupied[start : end + 1, edges[0] : edges[2] + 1], axis=1)
            best = np.lexsort((np.abs(positions - ideal), costs))[0]
            edges[side] = int(positions[best])
        candidate = (edges[0], edges[1], edges[2] - edges[0] + 1, edges[3] - edges[1] + 1)
        if candidate not in candidates:
            candidates.append(candidate)
    candidates.extend(expand_bbox(box, padding, width, height) for padding in padding_steps)
    for x, y, box_width, box_height in candidates:
        polygon = np.asarray(
            [
                (x, y),
                (x + box_width - 1, y),
                (x + box_width - 1, y + box_height - 1),
                (x, y + box_height - 1),
            ],
            dtype=np.int32,
        )
        if not polygon_is_safe(
            polygon,
            source_mask,
            foreground_mask_image,
            clearance=clearance,
        ):
            continue
        return {
            "rect": {
                "x": round((x + offset_x) / canvas_width, 6),
                "y": round((y + offset_y) / canvas_height, 6),
                "width": round(box_width / canvas_width, 6),
                "height": round(box_height / canvas_height, 6),
            },
            "selectionType": "rectangle",
            "points": [],
        }
    return None


def background_safe_region_from_mask(
    source_mask: np.ndarray,
    foreground_mask_image: np.ndarray,
    box: BBox,
    width: int,
    height: int,
) -> dict | None:
    """先围住完整区域；间隙窄时缩小留白，始终检查真实前景和圆角。"""
    for clearance in (boundary_clearance(width, height), 1, 0):
        region = safe_rectangle_region_from_mask(
            source_mask, foreground_mask_image, box, width, height,
            clearance=clearance,
        )
        if region is not None:
            return region
        for padding in adaptive_padding_steps(box, width, height):
            region = polygon_region_from_mask(
                source_mask,
                width,
                height,
                padding=padding,
                obstacle_mask=foreground_mask_image,
                clearance=clearance,
            )
            if region is not None:
                return region
    return None


def build_auto_regions(
    image: np.ndarray,
    min_region_threshold: int = 2,
    preferred_count: int | None = None,
) -> List[dict]:
    """生成从上到下、同位置面积升序的圈选结果，并以整图框结尾。"""
    height, width = image.shape[:2]
    mask = foreground_mask(image)
    obstacle_mask = boundary_obstacle_mask(image, mask)
    canvas_area = width * height
    target_count = max(10, min(18, int(preferred_count or 6) * 2))
    grouped_candidates: List[Tuple[int, float, np.ndarray, List[Tuple[int, int, BBox]]]] = []
    independent_points: List[Tuple[int, int]] = []

    for width_ratio, height_ratio in (
        (0.0, 0.0),
        (0.006, 0.004),
        (0.012, 0.006),
        (0.020, 0.009),
        (0.032, 0.013),
    ):
        kernel_width = max(1, int(round(width * width_ratio)))
        kernel_height = max(1, int(round(height * height_ratio)))
        grouped = cv2.morphologyEx(
            mask,
            cv2.MORPH_CLOSE,
            cv2.getStructuringElement(
                cv2.MORPH_RECT,
                (kernel_width | 1, kernel_height | 1),
            ),
            iterations=1,
        )
        # 封闭轮廓内的图标、文字与外框属于同一区域；不把整页装饰边框填满。
        grouped = fill_component_interiors(grouped)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(grouped, connectivity=8)
        components: List[Tuple[int, int, BBox]] = []
        for index in range(1, count):
            x, y, box_width, box_height, area = stats[index].tolist()
            box_ratio = box_width * box_height / canvas_area
            if area < max(80, int(canvas_area * 0.00004)):
                continue
            if box_width < 10 or box_height < 10 or box_ratio > 0.72:
                continue
            components.append((area, index, (x, y, box_width, box_height)))

        if not components:
            continue
        largest_ratio = max(box_area(box) / canvas_area for _, _, box in components)
        # 候选数量接近目标并不代表尺度合适：若一个连通域已经吞掉近半画布，
        # 应优先回退到更细的尺度，避免多个主体先粘成一个整体。
        score = abs(len(components) - target_count) + max(0.0, largest_ratio - 0.48) * 100
        # 较粗尺度不能仅因数量更接近预期，就把细尺度的多个主体粘成一块。
        parent_labels = [int(labels[py, px]) for px, py in independent_points]
        parent_labels = [label for label in parent_labels if label != 0]
        merged_count = len(parent_labels) - len(set(parent_labels))
        grouped_candidates.append((merged_count, score, labels, components))
        if not independent_points:
            for _, index, (x, y, box_width, box_height) in components:
                if box_width * box_height >= canvas_area * 0.02:
                    ys, xs = np.nonzero(labels[y : y + box_height, x : x + box_width] == index)
                    # 描边主体的中心可能是空白，使用真实分量像素跟踪其归属。
                    sample = len(xs) // 2
                    independent_points.append((x + int(xs[sample]), y + int(ys[sample])))

    if not grouped_candidates:
        return [{
            "rect": {"x": 0, "y": 0, "width": 1, "height": 1},
            "selectionType": "rectangle",
            "points": [],
        }]

    grouped_candidates.sort(key=lambda item: (item[0], item[1]))
    _, _, labels, component_entries = grouped_candidates[0]
    ranked: List[Tuple[int, np.ndarray, BBox, bool]] = []
    for area, index, box in component_entries:
        component_mask = (labels == index).astype(np.uint8) * 255
        for part_mask, part_box, was_split in split_merged_component(
            component_mask,
            obstacle_mask,
            width,
            height,
        ):
            ranked.append((
                int(np.count_nonzero(part_mask)),
                part_mask,
                part_box,
                was_split,
            ))
    ranked.sort(key=lambda item: item[0], reverse=True)

    threshold = max(1, min(100, int(min_region_threshold)))
    largest_ratio = max(box_area(box) / canvas_area for _, _, box, _ in ranked)
    if threshold <= 2:
        min_area_ratio = 0
    else:
        baseline = 0.02 if largest_ratio >= 0.02 else 0
        progress = (threshold - 2) / 98
        min_area_ratio = baseline + (largest_ratio - baseline) * progress

    # 即使过滤强度最低，也把极小碎片并入附近主体；阈值全程使用画布占比，
    # 不依赖具体分辨率、颜色或版式。
    merge_area_ratio = max(0.006, min_area_ratio)
    selected = merge_small_components(
        ranked,
        width,
        height,
        merge_area_ratio,
        preferred_count,
    )
    if not selected:
        selected = ranked[:1]

    # 复查未分配的前景，补回曾因短边限制等原因漏掉的有效笔画，仍过滤微小噪点。
    covered = np.zeros_like(mask)
    for _, component_mask, _, _ in selected:
        cv2.bitwise_or(covered, component_mask, dst=covered)
    missing = cv2.bitwise_and(mask, cv2.bitwise_not(covered))
    missing_count, missing_labels, missing_stats, _ = cv2.connectedComponentsWithStats(missing, connectivity=8)
    anchor_boxes = [candidate[2] for candidate in selected]
    for index in range(1, missing_count):
        x, y, box_width, box_height, pixels = missing_stats[index].tolist()
        if pixels < max(80, int(canvas_area * 0.00004)) or box_width * box_height > canvas_area * 0.72:
            continue
        box = (x, y, box_width, box_height)
        target_index = min(
            range(len(selected)),
            key=lambda target: box_gap_score(box, anchor_boxes[target], width, height),
        )
        candidate = (pixels, (missing_labels == index).astype(np.uint8) * 255, box, False)
        selected[target_index] = merge_region_candidates(selected[target_index], candidate)

    # 输出数量受编辑器限制时合并末尾小组，不能直接截断而丢掉内容。
    selected.sort(key=lambda item: item[0], reverse=True)
    while len(selected) > 49:
        candidate = selected.pop()
        target_index = min(
            range(len(selected)),
            key=lambda target: box_gap_score(candidate[2], selected[target][2], width, height),
        )
        selected[target_index] = merge_region_candidates(selected[target_index], candidate)
        selected.sort(key=lambda item: item[0], reverse=True)

    def detect(candidate: RegionCandidate) -> dict | None:
        _, component_mask, box, _ = candidate
        restored_mask = restore_target_edges(component_mask, mask, obstacle_mask, box)
        restored_box = mask_bbox(restored_mask) or box
        region = background_safe_region_from_mask(
            restored_mask,
            obstacle_mask,
            restored_box,
            width,
            height,
        )
        if region is None:
            # 弱色差像素只作为优先避让项；退回全图可靠前景仍须完整包住主体，
            # 不能退回只检查当前目标，也不能输出未经校验的矩形。
            region = safe_rectangle_region_from_mask(
                component_mask, mask, box, width, height, clearance=0,
            )
        return region

    detected: List[Tuple[RegionCandidate, dict]] = []
    pending: List[RegionCandidate] = []
    for candidate in selected:
        region = detect(candidate)
        if region is None:
            pending.append(candidate)
        else:
            detected.append((candidate, region))

    # 小组边界找不到空隙时，先与邻组一并围住；不因一次失败就直接漏掉。
    skipped_boxes: List[BBox] = []
    rescue_boxes = [candidate[2] for candidate, _ in detected]
    for candidate in sorted(pending, key=lambda item: box_area(item[2])):
        neighbors = sorted(
            range(len(detected)),
            key=lambda index: box_gap_score(candidate[2], rescue_boxes[index], width, height),
        )
        for index in neighbors[:3]:
            target = detected[index][0]
            if (
                grouping_area(candidate[2]) > max(canvas_area * merge_area_ratio, grouping_area(rescue_boxes[index]) * 0.5)
                or box_gap_score(candidate[2], rescue_boxes[index], width, height) > 0.08
            ):
                continue
            merged = merge_region_candidates(target, candidate)
            region = detect(merged)
            if region is not None:
                detected[index] = (merged, region)
                break
        else:
            skipped_boxes.append(candidate[2])

    if skipped_boxes:
        print(
            f"[WARN] {len(skipped_boxes)} 个候选没有安全边界，已跳过，请手动框选：{skipped_boxes}",
            file=sys.stderr,
        )

    ordered_regions = sort_regions_top_then_left(
        [(candidate[2], region) for candidate, region in detected], height,
    )
    regions = [region for _, region in ordered_regions]
    regions.append({
        "rect": {
            "x": 0,
            "y": 0,
            "width": 1,
            "height": 1,
        },
        "selectionType": "rectangle",
        "points": [],
    })
    return regions


class BoxAnnotator:
    def __init__(
        self,
        image: np.ndarray,
        image_path: Path,
        output_dir: Path,
        padding: int = 56,
        show_proposals: bool = True,
    ) -> None:
        self.image = image
        self.image_path = image_path
        self.output_dir = output_dir
        self.height, self.width = image.shape[:2]

        self.padding = max(0, int(padding))
        self.foreground = boundary_obstacle_mask(image, foreground_mask(image))
        self.proposals = auto_proposals(image)
        self.show_proposals = show_proposals

        self.selected: List[BBox] = []

        self.dragging = False
        self.drag_start_disp = (0, 0)
        self.drag_now_disp = (0, 0)

        self.window_name = "Object Boxer - OpenCV"

        max_display_w = 1500
        max_display_h = 880
        self.scale = min(
            1.0,
            max_display_w / self.width,
            max_display_h / self.height,
        )
        self.display_w = max(1, int(round(self.width * self.scale)))
        self.display_h = max(1, int(round(self.height * self.scale)))

    def original_to_display(self, x: int, y: int) -> Tuple[int, int]:
        return int(round(x * self.scale)), int(round(y * self.scale))

    def display_to_original(self, x: int, y: int) -> Tuple[int, int]:
        ox = int(round(x / self.scale))
        oy = int(round(y / self.scale))
        ox = max(0, min(self.width - 1, ox))
        oy = max(0, min(self.height - 1, oy))
        return ox, oy

    def proposal_at(self, ox: int, oy: int) -> BBox | None:
        hits = [b for b in self.proposals if point_in_box(ox, oy, b)]
        if not hits:
            return None
        return min(hits, key=box_area)

    def fit_selection(self, box: BBox) -> BBox:
        return fit_bbox_to_foreground(
            box,
            self.foreground,
            self.width,
            self.height,
        )

    def remove_selected_at(self, ox: int, oy: int) -> bool:
        for i in range(len(self.selected) - 1, -1, -1):
            if point_in_box(ox, oy, self.selected[i]):
                self.selected.pop(i)
                return True
        return False

    def on_mouse(self, event, x, y, flags, param) -> None:
        if event == cv2.EVENT_LBUTTONDOWN:
            self.dragging = True
            self.drag_start_disp = (x, y)
            self.drag_now_disp = (x, y)

        elif event == cv2.EVENT_MOUSEMOVE and self.dragging:
            self.drag_now_disp = (x, y)

        elif event == cv2.EVENT_LBUTTONUP and self.dragging:
            self.dragging = False
            self.drag_now_disp = (x, y)

            sx, sy = self.drag_start_disp
            ex, ey = self.drag_now_disp
            dx, dy = abs(ex - sx), abs(ey - sy)

            if dx < 6 and dy < 6:
                ox, oy = self.display_to_original(x, y)
                proposal = self.proposal_at(ox, oy)
                if proposal is not None:
                    self.selected.append(self.fit_selection(proposal))
                return

            x1d, x2d = sorted([sx, ex])
            y1d, y2d = sorted([sy, ey])
            x1, y1 = self.display_to_original(x1d, y1d)
            x2, y2 = self.display_to_original(x2d, y2d)

            w = max(1, x2 - x1)
            h = max(1, y2 - y1)
            if w >= 4 and h >= 4:
                box = clamp_bbox((x1, y1, w, h), self.width, self.height)
                self.selected.append(self.fit_selection(box))

        elif event == cv2.EVENT_RBUTTONDOWN:
            ox, oy = self.display_to_original(x, y)
            self.remove_selected_at(ox, oy)

    def draw_box(
        self,
        canvas: np.ndarray,
        box: BBox,
        color: Tuple[int, int, int],
        thickness: int = 2,
        label: str | None = None,
        dashed: bool = False,
    ) -> None:
        x, y, w, h = box
        x1, y1 = self.original_to_display(x, y)
        x2, y2 = self.original_to_display(x + w, y + h)

        if dashed:
            dash = 10
            for xx in range(x1, x2, dash * 2):
                cv2.line(canvas, (xx, y1), (min(xx + dash, x2), y1), color, thickness)
                cv2.line(canvas, (xx, y2), (min(xx + dash, x2), y2), color, thickness)
            for yy in range(y1, y2, dash * 2):
                cv2.line(canvas, (x1, yy), (x1, min(yy + dash, y2)), color, thickness)
                cv2.line(canvas, (x2, yy), (x2, min(yy + dash, y2)), color, thickness)
        else:
            cv2.rectangle(canvas, (x1, y1), (x2, y2), color, thickness)

        if label:
            ty = max(18, y1 - 7)
            cv2.putText(
                canvas,
                label,
                (x1 + 3, ty),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                color,
                1,
                cv2.LINE_AA,
            )

    def render(self) -> np.ndarray:
        canvas = cv2.resize(
            self.image,
            (self.display_w, self.display_h),
            interpolation=cv2.INTER_AREA,
        )

        if self.show_proposals:
            for box in self.proposals:
                self.draw_box(canvas, box, (0, 170, 255), 1)

        for i, box in enumerate(self.selected, start=1):
            safe = expand_bbox(box, self.padding, self.width, self.height)
            self.draw_box(canvas, safe, (255, 220, 0), 1, dashed=True)
            self.draw_box(canvas, box, (80, 255, 80), 2, f"obj_{i:03d}")

        if self.dragging:
            sx, sy = self.drag_start_disp
            ex, ey = self.drag_now_disp
            cv2.rectangle(canvas, (sx, sy), (ex, ey), (255, 255, 255), 2)

        help_text = (
            f"Left drag:add | Left click:accept proposal | Right click:delete | "
            f"U:undo C:clear P:proposal +/-:padding({self.padding}) S:save Q/Esc:quit"
        )
        cv2.rectangle(canvas, (0, 0), (self.display_w, 30), (0, 0, 0), -1)
        cv2.putText(
            canvas,
            help_text,
            (8, 21),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.48,
            (230, 230, 230),
            1,
            cv2.LINE_AA,
        )
        return canvas

    def build_scene(self) -> dict:
        objects: List[SelectedObject] = []

        for i, selected_box in enumerate(self.selected, start=1):
            box = selected_box
            x, y, w, h = box
            safe = expand_bbox(box, self.padding, self.width, self.height)
            sx, sy, sw, sh = safe

            obj = SelectedObject(
                id=f"obj_{i:03d}",
                bbox=[x, y, w, h],
                safe_bbox=[sx, sy, sw, sh],
                center=[
                    round((x + w / 2) / self.width, 6),
                    round((y + h / 2) / self.height, 6),
                ],
                bbox_norm=normalize_bbox(box, self.width, self.height),
                safe_bbox_norm=normalize_bbox(safe, self.width, self.height),
            )
            objects.append(obj)

        return {
            "image": self.image_path.name,
            "width": self.width,
            "height": self.height,
            "padding": self.padding,
            "coordinate_system": "pixel bbox = [x, y, w, h], origin = top-left",
            "objects": [asdict(o) for o in objects],
        }

    def save(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        crops_dir = self.output_dir / "crops"
        opaque_crops_dir = self.output_dir / "crops_opaque"
        crops_dir.mkdir(parents=True, exist_ok=True)
        opaque_crops_dir.mkdir(parents=True, exist_ok=True)

        scene = self.build_scene()

        background_bgr = np.median(
            np.concatenate(
                [
                    self.image[: max(8, min(self.height, self.width) // 60), :, :].reshape(-1, 3),
                    self.image[-max(8, min(self.height, self.width) // 60) :, :, :].reshape(-1, 3),
                    self.image[:, : max(8, min(self.height, self.width) // 60), :].reshape(-1, 3),
                    self.image[:, -max(8, min(self.height, self.width) // 60) :, :].reshape(-1, 3),
                ],
                axis=0,
            ),
            axis=0,
        ).astype(np.uint8)
        background_lab = cv2.cvtColor(background_bgr.reshape(1, 1, 3), cv2.COLOR_BGR2LAB).reshape(3).astype(np.float32)

        json_path = self.output_dir / "scene_boxes.json"
        json_path.write_text(
            json.dumps(scene, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        preview = self.image.copy()
        for i, selected_box in enumerate(self.selected, start=1):
            box = selected_box
            safe = expand_bbox(box, self.padding, self.width, self.height)
            x, y, w, h = box
            sx, sy, sw, sh = safe

            cv2.rectangle(preview, (sx, sy), (sx + sw, sy + sh), (255, 220, 0), 2)
            cv2.rectangle(preview, (x, y), (x + w, y + h), (80, 255, 80), 3)
            cv2.putText(
                preview,
                f"obj_{i:03d}",
                (x + 4, max(24, y - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (80, 255, 80),
                2,
                cv2.LINE_AA,
            )

            crop = extract_padded_crop(
                self.image,
                box,
                self.padding,
                background_bgr,
            )
            crop_lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).astype(np.float32)
            distance = np.linalg.norm(crop_lab - background_lab[None, None, :], axis=2)
            background_mask = distance < 18
            crop[background_mask] = background_bgr
            cv2.imwrite(str(opaque_crops_dir / f"obj_{i:03d}.png"), crop)

            alpha = np.clip((distance - 8.0) / 18.0 * 255.0, 0, 255).astype(np.uint8)
            alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
            cutout = cv2.cvtColor(crop, cv2.COLOR_BGR2BGRA)
            cutout[:, :, 3] = alpha
            cv2.imwrite(str(crops_dir / f"obj_{i:03d}.png"), cutout)

        cv2.imwrite(str(self.output_dir / "preview_boxes.png"), preview)

        print(f"[OK] Saved: {json_path}")
        print(f"[OK] Preview: {self.output_dir / 'preview_boxes.png'}")
        print(f"[OK] Transparent crops: {crops_dir}")
        print(f"[OK] Opaque crops: {opaque_crops_dir}")
        print(f"[INFO] Selected objects: {len(self.selected)}")
        print(f"[INFO] Padding: {self.padding}px")

    def run(self) -> None:
        cv2.namedWindow(self.window_name, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(self.window_name, self.display_w, self.display_h)
        cv2.setMouseCallback(self.window_name, self.on_mouse)

        while True:
            canvas = self.render()
            cv2.imshow(self.window_name, canvas)

            key = cv2.waitKey(20) & 0xFF

            if key in (27, ord("q"), ord("Q")):
                break
            elif key in (ord("u"), ord("U")):
                if self.selected:
                    self.selected.pop()
            elif key in (ord("c"), ord("C")):
                self.selected.clear()
            elif key in (ord("p"), ord("P")):
                self.show_proposals = not self.show_proposals
            elif key in (ord("s"), ord("S")):
                self.save()
            elif key in (ord("+"), ord("=")):
                self.padding += 4
            elif key in (ord("-"), ord("_")):
                self.padding = max(0, self.padding - 4)

        cv2.destroyAllWindows()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenCV 独立物品框选 + safe bbox 导出")
    parser.add_argument("image", type=str, help="输入图片路径")
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="输出目录，默认 <图片名>_boxes",
    )
    parser.add_argument(
        "--padding",
        type=int,
        default=56,
        help="safe_bbox 额外安全边距(px)，默认 56",
    )
    parser.add_argument(
        "--no-proposals",
        action="store_true",
        help="不显示 OpenCV 自动候选框，只手动画框",
    )
    parser.add_argument(
        "--auto-json",
        action="store_true",
        help="无界面运行并向标准输出返回流程 3 可用的区域 JSON",
    )
    parser.add_argument(
        "--min-region-threshold",
        type=int,
        default=2,
        help="区域过滤强度(1-100)，默认 2",
    )
    parser.add_argument(
        "--preferred-count",
        type=int,
        default=None,
        help="优先保留的区域数量(1-50)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    image_path = Path(args.image).expanduser().resolve()
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"OpenCV cannot read image: {image_path}")

    if args.auto_json:
        regions = build_auto_regions(
            image,
            min_region_threshold=args.min_region_threshold,
            preferred_count=args.preferred_count,
        )
        print(json.dumps({
            "width": image.shape[1],
            "height": image.shape[0],
            "regions": regions,
        }, ensure_ascii=False))
        return

    if args.output:
        output_dir = Path(args.output).expanduser().resolve()
    else:
        output_dir = image_path.parent / f"{image_path.stem}_boxes"

    app = BoxAnnotator(
        image=image,
        image_path=image_path,
        output_dir=output_dir,
        padding=args.padding,
        show_proposals=not args.no_proposals,
    )
    app.run()


if __name__ == "__main__":
    main()
