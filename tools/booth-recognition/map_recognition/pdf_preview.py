from dataclasses import dataclass
import math
from pathlib import Path

from PIL import Image


@dataclass
class PdfPreview:
    page: int
    image: Image.Image
    transform: tuple[float, float, float, float, float, float]

    def to_dict(self) -> dict[str, object]:
        return {
            "image": f"page-{self.page:03}-pdf.png",
            "width": self.image.width, "height": self.image.height,
            "transform": list(self.transform),
        }


def render_pdf_previews(
    source: str | Path, images: dict[int, Image.Image], *, image_border: int = 0,
) -> dict[int, PdfPreview]:
    import pypdfium2 as pdfium

    if isinstance(image_border, bool) or not isinstance(image_border, int) or image_border < 0:
        raise ValueError("PDF preview image_border must be a nonnegative integer")
    previews = {}
    with pdfium.PdfDocument(source) as document:
        for number, image in images.items():
            if number < 1 or number > len(document):
                raise ValueError(f"PDF preview page is out of range: {number}")
            page = document[number - 1]
            try:
                # The recognizer selects one large embedded map, not a composed group of images.
                objects = [item for item in page.get_objects(max_depth=1) if isinstance(item, pdfium.PdfImage)]
                objects.sort(key=lambda item: item.get_px_size()[0] * item.get_px_size()[1], reverse=True)
                if not objects:
                    raise ValueError(f"PDF page {number}: embedded map placement not found")
                map_image = objects[0]
                width, height = map_image.get_px_size()
                if image.size != (width + image_border * 2, height + image_border * 2):
                    raise ValueError(f"PDF page {number}: recognition image dimensions do not match embedded map")
                matrix = map_image.get_matrix()
                if (not all(math.isfinite(value) for value in matrix.get())
                        or abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-12):
                    raise ValueError(f"PDF page {number}: map placement is singular or nonfinite")
                scale = max(width / max(1e-12, (matrix.a ** 2 + matrix.b ** 2) ** 0.5),
                            height / max(1e-12, (matrix.c ** 2 + matrix.d ** 2) ** 0.5))
                bitmap = page.render(scale=scale)
                try:
                    convert = bitmap.get_posconv(page)
                    top_left = convert.to_bitmap(*matrix.on_point(0, 1))
                    top_right = convert.to_bitmap(*matrix.on_point(1, 1))
                    bottom_left = convert.to_bitmap(*matrix.on_point(0, 0))
                    a, b = ((top_right[i] - top_left[i]) / width for i in range(2))
                    c, d = ((bottom_left[i] - top_left[i]) / height for i in range(2))
                    if abs(a * d - b * c) < 1e-12:
                        raise ValueError(f"PDF page {number}: map placement is singular")
                    transform = (
                        a, b, c, d, top_left[0] - image_border * (a + c),
                        top_left[1] - image_border * (b + d),
                    )
                    previews[number] = PdfPreview(number, bitmap.to_pil().convert("RGB").copy(), transform)
                finally:
                    bitmap.close()
            finally:
                page.close()
    return previews