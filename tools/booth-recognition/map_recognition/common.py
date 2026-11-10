from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Sequence

import numpy as np
from numpy.typing import NDArray
from PIL import Image

ImageArray = NDArray[np.uint8]


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    width: int
    height: int

    def to_dict(self) -> dict[str, int]:
        return {
            "x": self.x, "y": self.y,
            "width": self.width, "height": self.height,
        }


@dataclass(frozen=True)
class Reading:
    text: str
    score: float


class TextReader(Protocol):
    def read(self, images: Sequence[ImageArray]) -> list[Reading]: ...


class PaddleTextReader:
    def __init__(
        self,
        model_name: str,
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


def opaque_rgb(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    return Image.alpha_composite(Image.new("RGBA", rgba.size, "white"), rgba).convert("RGB")
