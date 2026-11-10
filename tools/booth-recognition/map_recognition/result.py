import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

from booth_recognition import RecognitionResult
from island_recognition import IslandMarker
from island_recognition.context import PageRefinement


@dataclass
class MapRecognitionResult:
    booths: RecognitionResult
    islands: dict[int, list[IslandMarker]]
    island_model: str | None
    island_kana_model: str | None = None
    refinements: dict[int, PageRefinement] | None = None
    stage1_data: dict[str, object] | None = None

    def to_dict(self) -> dict[str, object]:
        data = self.booths.to_dict()
        data["schemaVersion"] = 3 if self.refinements is not None else 2
        data["processingSteps"] = ["ocr", "island_context"] if self.refinements is not None else ["ocr"]
        data["islandModel"] = self.island_model
        data["islandKanaModel"] = self.island_kana_model
        data["islandCounts"] = dict(Counter(m.status for markers in self.islands.values() for m in markers))
        data["pages"] = [
            {
                **page.to_dict(),
                "islandMarkers": [m.to_dict() for m in self.islands[page.page]],
                "islandCounts": dict(Counter(m.status for m in self.islands[page.page])),
                **({"islandInference": self.refinements[page.page].to_dict()} if self.refinements is not None else {}),
            }
            for page in self.booths.pages
        ]
        return data

    def save(self, directory: str | Path) -> Path:
        directory = Path(directory)
        self.booths.save(directory)
        colors = {
            "recognized": "#8b35d1", "needs_review": "#e08000",
            "unrecognized": "#df2020", "not_run": "#2275dd",
        }
        for page in self.booths.pages:
            target = directory / f"page-{page.page:03}-overlay.png"
            with Image.open(target) as source:
                overlay = source.convert("RGB")
            draw = ImageDraw.Draw(overlay)
            for marker in self.islands[page.page]:
                b = marker.bbox
                color = colors[marker.status]
                draw.rectangle(
                    (b.x, b.y, b.x + b.width - 1, b.y + b.height - 1),
                    outline=color, width=2,
                )
                # ASCII occurrence IDs keep PNG export portable without a Japanese font.
                draw.text((b.x, max(0, b.y - 12)), marker.id.rsplit("-", 1)[-1], fill=color)
            overlay.save(target)
        if self.stage1_data is not None:
            (directory / "step-1.json").write_text(
                json.dumps(self.stage1_data, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8",
            )
        target = directory / "result.json"
        target.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8",
        )
        return target
