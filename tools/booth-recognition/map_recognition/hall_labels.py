import logging
import re
import unicodedata
from dataclasses import dataclass, field, replace
from typing import Literal, Sequence

import cv2
import numpy as np
from PIL import Image

from .common import Box, ImageArray, PaddleTextReader, TextReader, opaque_rgb

LOGGER = logging.getLogger(__name__)
DIRECTIONS = {"東": "E", "西": "W", "南": "S", "北": "N"}


@dataclass(frozen=True)
class HallLabel:
    id: str
    bbox: Box
    text: str | None = None
    label: str | None = None
    code: str | None = None
    recognition_score: float | None = None
    rotation: int = 0
    status: Literal["recognized", "needs_review", "not_run"] = "not_run"
    issues: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id, "text": self.text, "label": self.label, "code": self.code,
            "bbox": self.bbox.to_dict(),
            "center": {"x": self.bbox.x + self.bbox.width / 2, "y": self.bbox.y + self.bbox.height / 2},
            "recognitionScore": self.recognition_score, "rotation": self.rotation,
            "status": self.status, "issues": self.issues,
        }


def label_tokens(text: str) -> list[tuple[str, str]]:
    normalized = re.sub(r"[\s/／|・]+", "", unicodedata.normalize("NFKC", text)).upper().replace("⻄", "西")
    if not re.fullmatch(r"(?:(?:[東西南北EWSN])[1-9][0-9]?){1,2}", normalized):
        return []
    return [
        (DIRECTIONS.get(direction, direction) + number, "ja" if direction in DIRECTIONS else "en")
        for direction, number in re.findall(r"([東西南北EWSN])([1-9][0-9]?)", normalized)
    ]


def detect_label_text(image: Image.Image, booths: Sequence[Box] = ()) -> tuple[list[Box], ImageArray]:
    rgb = np.asarray(opaque_rgb(image))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    _, components, stats, _ = cv2.connectedComponentsWithStats((gray > 210).astype(np.uint8))
    selected = []
    for index, (x, y, width, height, area) in enumerate(stats[1:], 1):
        if area < 4 or min(width, height) < 2 or max(width, height) > 100:
            continue
        neighborhood = gray[max(0, y - 3):y + height + 3, max(0, x - 3):x + width + 3]
        if (neighborhood < 170).mean() > 0.4:
            selected.append(index)
    mask = np.isin(components, selected).astype(np.uint8) * 255
    dark = ((gray < 170) & (np.ptp(rgb, axis=2) <= 20)).astype(np.uint8)
    for box in booths:
        dark[box.y:box.y + box.height, box.x:box.x + box.width] = 0
    _, dark_components, dark_stats, _ = cv2.connectedComponentsWithStats(dark)
    dark_selected = []
    for index, (x, y, width, height, area) in enumerate(dark_stats[1:], 1):
        if area < 4 or area > 2000 or min(width, height) < 2 or max(width, height) > 100:
            continue
        neighborhood = gray[max(0, y - 3):y + height + 3, max(0, x - 3):x + width + 3]
        if (neighborhood > 210).mean() > 0.4 and area / (width * height) < 0.85:
            dark_selected.append(index)
    mask |= np.isin(dark_components, dark_selected).astype(np.uint8) * 255
    merged = cv2.dilate(mask, np.ones((15, 15), np.uint8))
    contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        ys, xs = np.nonzero(mask[y:y + height, x:x + width])
        box = Box(x + int(xs.min()), y + int(ys.min()), int(np.ptp(xs)) + 1, int(np.ptp(ys)) + 1)
        if min(box.width, box.height) >= 8 and max(box.width, box.height) >= 18:
            boxes.append(box)
    return sorted(boxes, key=lambda b: (b.y, b.x)), mask


def _line_crops(
    mask: ImageArray, box: Box, rotation: int, gray: ImageArray | None = None,
) -> list[ImageArray]:
    patch = mask[box.y:box.y + box.height, box.x:box.x + box.width]
    if gray is not None:
        source = gray[box.y:box.y + box.height, box.x:box.x + box.width]
        # Localization can include a glyph's enclosed counter; OCR must preserve its original polarity.
        patch = ((source > 210) if (source < 170).mean() > 0.5 else (source < 170)).astype(np.uint8) * 255
    patch = np.rot90(patch, rotation // 90)
    rows = np.flatnonzero(patch.any(axis=1))
    groups: list[list[int]] = []
    for row in rows:
        if groups and row - groups[-1][-1] <= 3:
            groups[-1].append(int(row))
        else:
            groups.append([int(row)])
    crops = []
    for group in groups:
        line = patch[group[0]:group[-1] + 1]
        columns = np.flatnonzero(line.any(axis=0))
        line = 255 - line[:, columns[0]:columns[-1] + 1]
        height, width = line.shape
        line = cv2.resize(line, (max(1, round(width * 64 / height)), 64), interpolation=cv2.INTER_CUBIC)
        line = cv2.copyMakeBorder(line, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)
        crops.append(cv2.cvtColor(line, cv2.COLOR_GRAY2BGR))
    return crops


class HallLabelRecognizer:
    def __init__(
        self, *, reader: TextReader | None = None, detect_only: bool = False, confidence: float = 0.9,
    ) -> None:
        if not 0 < confidence <= 1:
            raise ValueError("confidence must be in (0, 1]")
        self.reader = reader
        self.detect_only = detect_only
        self.confidence = confidence

    def recognize_image(
        self, image: Image.Image, *, page: int = 1, booths: Sequence[Box] = (),
    ) -> list[HallLabel]:
        if isinstance(page, bool) or not isinstance(page, int) or page < 1:
            raise ValueError("page must be a positive integer")
        for box in booths:
            if (box.x < 0 or box.y < 0 or box.width <= 0 or box.height <= 0
                    or box.x + box.width > image.width or box.y + box.height > image.height):
                raise ValueError("Hall label Booth bbox is outside the source image")
        boxes, mask = detect_label_text(image, booths)
        if self.detect_only:
            return [HallLabel(f"p{page:03}-hall-{i:03}", box) for i, box in enumerate(boxes, 1)]
        if not boxes:
            LOGGER.info("Page %d: no hall label candidates found", page)
            return []
        if self.reader is None:
            self.reader = PaddleTextReader("PP-OCRv5_server_rec", batch_size=16)
        gray = cv2.cvtColor(np.asarray(opaque_rgb(image)), cv2.COLOR_RGB2GRAY)
        crops = []
        spans = []
        for box in boxes:
            for rotation in (0, 90, 180, 270):
                lines = _line_crops(mask, box, rotation, gray)
                spans.append((box, rotation, len(crops), len(lines)))
                crops.extend(lines)
        readings = self.reader.read(crops)
        if len(readings) != len(crops):
            raise RuntimeError("Hall label OCR returned a different number of readings than crops")
        if any(not np.isfinite(r.score) or not 0 <= r.score <= 1 for r in readings):
            raise RuntimeError("Hall label OCR returned an invalid score")
        candidates: dict[Box, tuple[tuple[int, float], HallLabel]] = {}
        for box, rotation, start, count in spans:
            matches = [(r, label_tokens(r.text)) for r in readings[start:start + count] if label_tokens(r.text)]
            if not matches:
                continue
            codes = {code for _, tokens in matches for code, _ in tokens}
            languages = {language for _, tokens in matches for _, language in tokens}
            score = min(r.score for r, _ in matches)
            code = next(iter(codes)) if len(codes) == 1 else None
            issues = ([] if code else ["conflicting_labels"]) + ([] if score >= self.confidence else ["low_confidence"])
            label = next((name + code[1:] for name, letter in DIRECTIONS.items() if code and code[0] == letter), None)
            record = HallLabel(
                "", box, " / ".join(r.text for r, _ in matches), label, code, score, rotation,
                "needs_review" if issues else "recognized", issues,
            )
            rank = (len(languages) if code else 0, score)
            if box not in candidates or rank > candidates[box][0]:
                candidates[box] = (rank, record)
        labels = self._pair([record for _, record in candidates.values()])
        labels.sort(key=lambda item: (item.bbox.y, item.bbox.x))
        result = [replace(item, id=f"p{page:03}-hall-{i:03}") for i, item in enumerate(labels, 1)]
        for item in result:
            if item.issues:
                LOGGER.warning("Hall label %s requires review: %s (%r)", item.id, item.issues, item.text)
        LOGGER.info("Page %d: recognized %d hall label occurrences", page, len(result))
        return result

    def _pair(self, labels: list[HallLabel]) -> list[HallLabel]:
        result: list[HallLabel] = []
        for label in labels:
            for index, other in enumerate(result):
                a, b = label.bbox, other.bbox
                gap = np.hypot(max(a.x - b.x - b.width, b.x - a.x - a.width, 0),
                               max(a.y - b.y - b.height, b.y - a.y - a.height, 0))
                if (not label.code or label.code != other.code or label.rotation != other.rotation
                        or gap > max(a.width, a.height, b.width, b.height) * 0.8):
                    continue
                # Only pair complementary languages, never two separate copies of the same sign.
                languages = {language for _, language in label_tokens(label.text or "")}
                other_languages = {language for _, language in label_tokens(other.text or "")}
                if languages & other_languages:
                    continue
                box = Box(min(a.x, b.x), min(a.y, b.y),
                          max(a.x + a.width, b.x + b.width) - min(a.x, b.x),
                          max(a.y + a.height, b.y + b.height) - min(a.y, b.y))
                issues = sorted(set(label.issues + other.issues))
                result[index] = replace(
                    other, bbox=box, text=f"{other.text} / {label.text}",
                    recognition_score=min(label.recognition_score or 0, other.recognition_score or 0),
                    status="needs_review" if issues else "recognized", issues=issues,
                )
                break
            else:
                result.append(label)
        return result
