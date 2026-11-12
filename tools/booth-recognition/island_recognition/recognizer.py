from __future__ import annotations

import logging
import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean, median
from typing import TYPE_CHECKING, Literal

import cv2
import numpy as np
from PIL import Image

from map_recognition.common import Box, ImageArray, PaddleTextReader, Reading, TextReader, opaque_rgb

if TYPE_CHECKING:
    from .context import MarkerInference

LOGGER = logging.getLogger(__name__)
Status = Literal["recognized", "needs_review", "unrecognized", "not_run"]


def valid_label(text: str) -> bool:
    text = unicodedata.normalize("NFC", text)
    return len(text) == 1 and re.fullmatch(r"[A-Za-z\u3041-\u3096\u30a1-\u30fa\u30fc]", text) is not None


def label_family(text: str) -> str:
    if "A" <= text <= "Z":
        return "uppercase"
    if "a" <= text <= "z":
        return "lowercase"
    return "hiragana" if "\u3041" <= text <= "\u3096" else "katakana"


@dataclass
class IslandMarker:
    id: str
    bbox: Box
    color: str
    label: str | None = None
    raw_text: str | None = None
    recognition_score: float | None = None
    rotation: int = 0
    status: Status = "not_run"
    issues: list[str] = field(default_factory=list)
    alternatives: list[dict[str, object]] = field(default_factory=list)
    inference: MarkerInference | None = None
    crop_retry: dict[str, object] | None = None

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {
            "id": self.id, "bbox": self.bbox.to_dict(), "color": self.color,
            "label": self.label, "rawText": self.raw_text,
            "recognitionScore": self.recognition_score, "rotation": self.rotation,
            "status": self.status, "issues": self.issues, "alternatives": self.alternatives,
        }
        if self.inference is not None:
            data["inference"] = self.inference.to_dict()
        if self.crop_retry is not None:
            data["cropRetry"] = self.crop_retry
        return data


def detect_markers(rgb: ImageArray) -> tuple[list[Box], ImageArray]:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    raw_mask = (
        (hsv[:, :, 1] >= 45) & (hsv[:, :, 2] >= 60) & (np.ptp(rgb, axis=2) >= 24)
    ).astype(np.uint8) * 255
    # Small romanization text can touch the main glyph; remove its thin strokes.
    mask = cv2.morphologyEx(raw_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    sizes = [max(int(s[2]), int(s[3])) for s in stats[1:] if s[4] >= 4]
    if not sizes:
        return [], mask
    scale = float(np.percentile(sizes, 75))
    cores = [
        i for i in range(1, count)
        if max(stats[i, 2:4]) >= max(4, scale * 0.4) and stats[i, 4] >= max(4, scale * 0.2)
    ]
    # Keep detached dots/diacritics aligned above or below a larger stroke.
    satellites = []
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if i in cores or area < 3:
            continue
        for core in cores:
            cx, cy, cw, ch, _ = stats[core]
            overlap = max(0, min(x + w, cx + cw) - max(x, cx))
            gap = max(cy - y - h, y - cy - ch, 0)
            if cw <= scale * 0.4 and ch > cw * 1.5 and overlap >= min(w, cw) * 0.5 and gap <= scale * 0.3:
                satellites.append(i)
                break
    filtered = np.isin(labels, cores + satellites).astype(np.uint8) * 255
    kernel = max(3, round(scale * 0.45) // 2 * 2 + 1)
    merged = cv2.dilate(filtered, np.ones((kernel, kernel), np.uint8))
    contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        ys, xs = np.where(filtered[y:y + h, x:x + w] > 0)
        if len(xs) == 0:
            continue
        left, top = x + int(xs.min()), y + int(ys.min())
        width, height = int(np.ptp(xs)) + 1, int(np.ptp(ys)) + 1
        if max(width, height) >= max(5, scale * 0.55):
            boxes.append(Box(left, top, width, height))
    return sorted(boxes, key=lambda box: (box.y, box.x)), raw_mask


def marker_crop(mask: ImageArray, box: Box, rotation: int, *, clean: bool = False) -> ImageArray:
    patch = mask[box.y:box.y + box.height, box.x:box.x + box.width]
    if clean:
        patch = cv2.morphologyEx(
            patch, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8),
            borderType=cv2.BORDER_CONSTANT, borderValue=0,
        )
    patch = np.rot90(255 - patch, rotation // 90).copy()
    height, width = patch.shape
    patch = cv2.resize(
        patch, (max(1, round(width * 64 / height)), 64), interpolation=cv2.INTER_CUBIC,
    )
    patch = cv2.copyMakeBorder(patch, 16, 16, 16, 16, cv2.BORDER_CONSTANT, value=255)
    return cv2.cvtColor(patch, cv2.COLOR_GRAY2BGR)


def marker_reference_size(boxes: list[Box]) -> tuple[float, float] | None:
    if len(boxes) < 5:
        return None
    width, height = median(b.width for b in boxes), median(b.height for b in boxes)
    typical = [b for b in boxes if 0.65 <= b.width / width <= 1.65 and 0.65 <= b.height / height <= 1.65]
    if len(typical) < 3 or len(typical) <= len(boxes) / 2:
        LOGGER.warning("Island crop retry skipped: no majority of consistent marker sizes")
        return None
    return mean(b.width for b in typical), mean(b.height for b in typical)


def expanded_marker_box(
    box: Box, reference: tuple[float, float], boxes: list[Box], image_width: int, image_height: int,
) -> Box:
    width = math.ceil(max(box.width, reference[0]) * 1.25)
    height = math.ceil(max(box.height, reference[1]) * 1.25)
    left = max(0, math.floor(box.x + (box.width - width) / 2))
    top = max(0, math.floor(box.y + (box.height - height) / 2))
    right = min(image_width, math.ceil(box.x + (box.width + width) / 2))
    bottom = min(image_height, math.ceil(box.y + (box.height + height) / 2))
    for other in boxes:
        if other == box or not (
            left < other.x + other.width and right > other.x
            and top < other.y + other.height and bottom > other.y
        ):
            continue
        if box.x + box.width <= other.x:
            right = min(right, (box.x + box.width + other.x) // 2)
        elif other.x + other.width <= box.x:
            left = max(left, math.ceil((other.x + other.width + box.x) / 2))
        if box.y + box.height <= other.y:
            bottom = min(bottom, (box.y + box.height + other.y) // 2)
        elif other.y + other.height <= box.y:
            top = max(top, math.ceil((other.y + other.height + box.y) / 2))
    return Box(left, top, right - left, bottom - top)


class IslandRecognizer:
    """Recognize colored marker occurrences, without assigning booths to islands."""

    def __init__(
        self, *, detect_only: bool = False, confidence: float = 0.90,
        model_name: str = "PP-OCRv5_server_rec",
        model_dir: str | Path | None = None, reader: TextReader | None = None,
        kana_model_name: str | None = "japan_PP-OCRv3_mobile_rec",
        kana_model_dir: str | Path | None = None, kana_reader: TextReader | None = None,
    ) -> None:
        if not 0 < confidence <= 1:
            raise ValueError("confidence must be in (0, 1]")
        if model_dir is not None and not Path(model_dir).is_dir():
            raise ValueError(f"Model directory does not exist: {model_dir}")
        if kana_model_dir is not None and not Path(kana_model_dir).is_dir():
            raise ValueError(f"Kana model directory does not exist: {kana_model_dir}")
        self.detect_only = detect_only
        self.confidence = confidence
        self.model_name = model_name
        self.model_dir = Path(model_dir) if model_dir is not None else None
        self._reader = reader
        self.kana_model_name = kana_model_name
        self.kana_model_dir = Path(kana_model_dir) if kana_model_dir is not None else None
        self._kana_reader = kana_reader

    @property
    def reader(self) -> TextReader:
        if self._reader is None:
            self._reader = PaddleTextReader(self.model_name, self.model_dir, batch_size=16)
        return self._reader

    def recognize_image(self, image: Image.Image, *, page: int = 1) -> list[IslandMarker]:
        if not isinstance(page, int) or isinstance(page, bool) or page < 1:
            raise ValueError("page must be a positive integer")
        rgb = np.asarray(opaque_rgb(image))
        boxes, mask = detect_markers(rgb)
        if not boxes:
            LOGGER.warning("Page %s: no colored island markers detected", page)
            return []
        markers = []
        for index, box in enumerate(boxes, 1):
            colored = rgb[box.y:box.y + box.height, box.x:box.x + box.width][
                mask[box.y:box.y + box.height, box.x:box.x + box.width] > 0
            ]
            color = Counter(map(tuple, colored.tolist())).most_common(1)[0][0]
            issues = []
            if (box.x == 0 or box.y == 0 or box.x + box.width == rgb.shape[1]
                    or box.y + box.height == rgb.shape[0]):
                issues.append("truncated_at_image_edge")
            markers.append(IslandMarker(
                f"p{page:03}-i{index:04}", box,
                "#" + "".join(f"{channel:02x}" for channel in color), issues=issues,
            ))
        LOGGER.info("Page %s: detected %s colored island marker candidates", page, len(markers))
        if self.detect_only:
            return markers

        rotations = (0, 90, 180, 270)
        evidence = []
        readings_by_rotation: dict[int, list[Reading]] = {}
        for rotation in rotations:
            readings = self.reader.read([marker_crop(mask, box, rotation) for box in boxes])
            if len(readings) != len(boxes):
                raise RuntimeError("Island reader returned the wrong number of results")
            readings_by_rotation[rotation] = readings
            evidence.append(sum(r.score for r in readings if valid_label(unicodedata.normalize("NFC", r.text))))
        order = sorted(range(4), key=lambda index: evidence[index], reverse=True)
        primary = rotations[order[0]]
        uncertain = evidence[order[0]] - evidence[order[1]] < len(boxes) * 0.03
        LOGGER.info("Island OCR rotation: %s CCW; evidence: %s", primary, evidence)
        primary_readings = readings_by_rotation[primary]
        kana_count = sum(
            valid_label(r.text) and "\u3041" <= r.text <= "\u30fc" for r in primary_readings
        )
        confident_count = sum(valid_label(r.text) and r.score >= self.confidence for r in primary_readings)
        kana_readings: list[Reading] | None = None
        if self.kana_model_name and (
            kana_count > len(boxes) * 0.25 or confident_count < len(boxes) * 0.60
        ):
            if self._kana_reader is None:
                self._kana_reader = PaddleTextReader(self.kana_model_name, self.kana_model_dir)
            kana_readings = self._kana_reader.read([marker_crop(mask, box, primary) for box in boxes])
            if len(kana_readings) != len(boxes):
                raise RuntimeError("Kana reader returned the wrong number of results")
        cleaned_readings = self.reader.read([
            marker_crop(mask, box, primary, clean=True) for box in boxes
        ])
        if len(cleaned_readings) != len(boxes):
            raise RuntimeError("Island reader returned the wrong number of cleaned results")
        for index, marker in enumerate(markers):
            candidates = [
                (rotation, readings_by_rotation[rotation][index]) for rotation in rotations
            ]
            rotation, reading = primary, readings_by_rotation[primary][index]
            local = [
                (self.model_name, reading),
                (f"{self.model_name}:clean", cleaned_readings[index]),
            ]
            if kana_readings is not None:
                local.append((self.kana_model_name, kana_readings[index]))
            valid_local = [(source, r) for source, r in local if valid_label(r.text)]
            labels = {r.text for _, r in valid_local if r.score >= 0.80}
            if len(labels) > 1:
                marker.issues.append("recognition_disagreement")
            if valid_local:
                _, reading = max(valid_local, key=lambda item: item[1].score)
            # Rotation alone must not replace a valid low-confidence character.
            if not valid_label(reading.text):
                rotation, reading = max(
                    candidates, key=lambda item: (valid_label(item[1].text), item[1].score),
                )
                if rotation != primary:
                    marker.issues.append("orientation_override")
            text = unicodedata.normalize("NFC", reading.text)
            marker.label = text if valid_label(text) else None
            marker.raw_text = reading.text
            marker.recognition_score = round(reading.score, 6)
            marker.rotation = rotation
            marker.alternatives = [
                {"label": r.text, "score": round(r.score, 6), "rotation": turn, "model": self.model_name}
                for turn, r in candidates if valid_label(r.text)
            ] + [
                {"label": r.text, "score": round(r.score, 6), "rotation": primary, "model": source}
                for source, r in local if valid_label(r.text)
            ]
            if marker.label is None:
                marker.issues.append("invalid_island_label")
            elif reading.score < self.confidence:
                marker.issues.append("low_confidence")
            if uncertain:
                marker.issues.append("uncertain_page_orientation")
            marker.status = (
                "unrecognized" if marker.label is None
                else "needs_review" if marker.issues else "recognized"
            )
        self._retry_size_outliers(mask, markers, primary, page=page)
        return markers

    def _retry_size_outliers(
        self, mask: ImageArray, markers: list[IslandMarker], rotation: int, *, page: int,
    ) -> None:
        boxes = [m.bbox for m in markers]
        reference = marker_reference_size(boxes)
        if reference is None:
            return
        retries = [
            (marker, expanded_marker_box(marker.bbox, reference, boxes, mask.shape[1], mask.shape[0]))
            for marker in markers
            if not (0.65 <= marker.bbox.width / reference[0] <= 1.65
                    and 0.65 <= marker.bbox.height / reference[1] <= 1.65)
        ]
        if not retries:
            return
        LOGGER.info("Page %s: retrying %s size-outlier marker crops; reference %.2f x %.2f",
                    page, len(retries), *reference)
        batches = [
            (f"{self.model_name}:expanded", self.reader.read([
                marker_crop(mask, box, rotation) for _, box in retries
            ])),
            (f"{self.model_name}:expanded:clean", self.reader.read([
                marker_crop(mask, box, rotation, clean=True) for _, box in retries
            ])),
        ]
        if self._kana_reader is not None:
            batches.append((f"{self.kana_model_name}:expanded", self._kana_reader.read([
                marker_crop(mask, box, rotation) for _, box in retries
            ])))
        if any(len(readings) != len(retries) for _, readings in batches):
            raise RuntimeError("Island reader returned the wrong number of expanded crop results")
        for index, (marker, box) in enumerate(retries):
            marker.crop_retry = {
                "referenceSize": {"width": reference[0], "height": reference[1]},
                "bbox": box.to_dict(),
                "original": {
                    "label": marker.label, "rawText": marker.raw_text,
                    "recognitionScore": marker.recognition_score, "rotation": marker.rotation,
                    "status": marker.status, "issues": list(marker.issues),
                },
                "accepted": False,
            }
            candidates = [(model, readings[index]) for model, readings in batches]
            marker.alternatives.extend({
                "label": r.text, "score": round(r.score, 6), "rotation": rotation, "model": model,
            } for model, r in candidates if valid_label(r.text))
            valid = [r for _, r in candidates if valid_label(r.text)]
            reliable = {unicodedata.normalize("NFC", r.text) for r in valid if r.score >= 0.80}
            old_score = marker.recognition_score or 0
            conflict = len(reliable) > 1 or (
                marker.label is not None and old_score >= 0.80
                and any(label != marker.label for label in reliable)
            )
            if conflict and "recognition_disagreement" not in marker.issues:
                marker.issues.append("recognition_disagreement")
            if valid:
                best = max(valid, key=lambda r: r.score)
                label = unicodedata.normalize("NFC", best.text)
                if len(reliable) == 1 and best.score >= self.confidence and (
                    marker.label is None or best.score >= old_score + 0.02
                    or (label == marker.label and best.score >= old_score)
                    or (marker.status != "recognized" and best.score > old_score)
                ):
                    marker.label, marker.raw_text = label, best.text
                    marker.recognition_score = round(best.score, 6)
                    marker.rotation = rotation
                    marker.issues = [issue for issue in marker.issues
                                     if issue not in {"low_confidence", "invalid_island_label"}]
                    marker.crop_retry["accepted"] = True
            marker.status = (
                "unrecognized" if marker.label is None
                else "needs_review" if marker.issues else "recognized"
            )
            LOGGER.info("Marker %s expanded crop: accepted=%s, label=%r, issues=%s",
                        marker.id, marker.crop_retry["accepted"], marker.label, marker.issues)
