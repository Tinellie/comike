from pathlib import Path

import cv2
import numpy as np

from .geometry import Box, ImageArray
from map_recognition.common import PaddleTextReader
from map_recognition.common import Reading as Reading, TextReader as DigitReader


class PaddleDigitReader(PaddleTextReader):
    def __init__(
        self,
        model_name: str = "en_PP-OCRv5_mobile_rec",
        model_dir: Path | None = None,
        batch_size: int = 32,
    ) -> None:
        super().__init__(model_name, model_dir, batch_size)


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
