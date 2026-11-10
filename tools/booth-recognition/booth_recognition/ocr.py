from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Sequence

import cv2
import numpy as np

from .geometry import Box, ImageArray


@dataclass(frozen=True)
class Reading:
    text: str
    score: float


class DigitReader(Protocol):
    def read(self, images: Sequence[ImageArray]) -> list[Reading]: ...


class PaddleDigitReader:
    def __init__(
        self,
        model_name: str = "en_PP-OCRv5_mobile_rec",
        model_dir: Path | None = None,
        batch_size: int = 32,
    ) -> None:
        from paddleocr import TextRecognition

        self.batch_size = batch_size
        self.model = TextRecognition(
            model_name=model_name,
            model_dir=str(model_dir) if model_dir else None,
            device="cpu",
            cpu_threads=4,
            enable_mkldnn=True,
        )

    def read(self, images: Sequence[ImageArray]) -> list[Reading]:
        if not images:
            return []
        results = list(self.model.predict(input=list(images), batch_size=self.batch_size))
        if len(results) != len(images):
            raise RuntimeError(f"OCR returned {len(results)} results for {len(images)} crops")
        readings = []
        for result in results:
            text = str(result["rec_text"]).strip()
            score = float(result["rec_score"])
            if not np.isfinite(score) or not 0 <= score <= 1:
                raise RuntimeError(f"OCR returned an invalid score: {score}")
            readings.append(Reading(text, score))
        return readings


def digit_crop(rgb: ImageArray, box: Box, rotation: int, binary: bool = False) -> ImageArray:
    inset = max(2, round(min(box.width, box.height) * 0.08))
    crop = rgb[
        box.y + inset:box.y + box.height - inset,
        box.x + inset:box.x + box.width - inset,
    ]
    crop = np.rot90(crop, rotation // 90).copy()
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    if binary:
        gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    height, width = gray.shape
    gray = cv2.resize(gray, (max(1, round(width * 64 / height)), 64), interpolation=cv2.INTER_CUBIC)
    gray = cv2.copyMakeBorder(gray, 8, 8, 8, 8, cv2.BORDER_CONSTANT, value=255)
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
