import logging
import math
import unicodedata
from collections import Counter
from copy import deepcopy
from dataclasses import dataclass
from statistics import median
from typing import Literal

from .recognizer import IslandMarker, Status, label_family, valid_label

LOGGER = logging.getLogger(__name__)
Outcome = Literal["corrected", "confirmed", "unresolved", "not_needed", "skipped"]
SEQUENCES: dict[str, str] = {
    "uppercase": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "lowercase": "abcdefghijklmnopqrstuvwxyz",
    "hiragana": "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん",
    "katakana": "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン",
}
TEXT_ISSUES = {"low_confidence", "invalid_island_label", "recognition_disagreement", "script_outlier"}


@dataclass(frozen=True)
class PageLabelType:
    label_type: str | None
    confidence: float
    votes: dict[str, float]
    counts: dict[str, int]
    distinct: dict[str, int]
    reason: str

    def to_dict(self) -> dict[str, object]:
        return {
            "type": self.label_type, "confidence": self.confidence,
            "votes": self.votes, "counts": self.counts,
            "distinctLabels": self.distinct, "reason": self.reason,
        }


class PageTypeInferer:
    def infer(self, markers: list[IslandMarker]) -> PageLabelType:
        counts = dict.fromkeys(SEQUENCES, 0)
        distinct: dict[str, dict[str, float]] = {family: {} for family in SEQUENCES}
        for marker in markers:
            if marker.status == "not_run" or marker.label is None:
                continue
            family = label_family(marker.label)
            counts[family] += 1
            score = marker.recognition_score or 0
            if score >= 0.5:
                distinct[family][marker.label] = max(distinct[family].get(marker.label, 0), score)
        # Repeated wall labels must not outweigh many independent interior labels.
        votes = {family: round(sum(labels.values()), 6) for family, labels in distinct.items()}
        order = sorted(votes, key=lambda family: votes[family], reverse=True)
        total = sum(votes.values())
        confidence = votes[order[0]] / total if total else 0
        decisive = len(distinct[order[0]]) >= 3 and confidence >= 0.75
        return PageLabelType(
            order[0] if decisive else None, round(confidence, 6), votes, counts,
            {family: len(labels) for family, labels in distinct.items()},
            "distinct_label_consensus" if decisive else "insufficient_or_conflicting_evidence",
        )


@dataclass(frozen=True)
class SequenceEvidence:
    label: str
    supporting_ids: list[str]
    axis: str
    bracketed: bool


class MarkerNeighborhood:
    def __init__(self, markers: list[IslandMarker], family: str) -> None:
        self.markers = markers
        self.sequence = SEQUENCES[family]
        self.family = family
        self.scale = median(max(m.bbox.width, m.bbox.height) for m in markers) if markers else 1

    def is_anchor(self, marker: IslandMarker) -> bool:
        return (
            marker.label is not None and marker.label in self.sequence
            and marker.status in ("recognized", "needs_review")
            and (marker.recognition_score or 0) >= 0.90
            and not (set(marker.issues) - {"truncated_at_image_edge"})
        )

    @staticmethod
    def center(marker: IslandMarker, axis: int) -> float:
        b = marker.bbox
        return b.x + b.width / 2 if axis == 0 else b.y + b.height / 2

    def infer(self, target: IslandMarker) -> list[SequenceEvidence]:
        evidence = []
        for axis in (0, 1):
            cross = 1 - axis
            line = sorted(
                (m for m in self.markers
                 if abs(self.center(m, cross) - self.center(target, cross)) <= self.scale * 0.65),
                key=lambda m: self.center(m, axis),
            )
            index = next(i for i, marker in enumerate(line) if marker.id == target.id)
            gaps = [self.center(b, axis) - self.center(a, axis) for a, b in zip(line, line[1:])]
            positive = [gap for gap in gaps if gap >= self.scale * 0.8]
            if not positive:
                continue
            limit = min(median(positive) * 2.2, self.scale * 8)
            anchors: list[tuple[int, IslandMarker]] = []
            for direction in (-1, 1):
                for step in range(1, 4):
                    other = index + direction * step
                    if not 0 <= other < len(line):
                        break
                    gap = gaps[min(other, other - direction)]
                    if gap < self.scale * 0.8 or gap > limit:
                        break
                    if self.is_anchor(line[other]):
                        anchors.append((direction * step, line[other]))
            if len(anchors) < 2:
                continue
            for direction in (-1, 1):
                predictions = {
                    self.sequence.index(marker.label) - direction * offset
                    for offset, marker in anchors if marker.label is not None
                }
                if len(predictions) != 1:
                    continue
                predicted = predictions.pop()
                if 0 <= predicted < len(self.sequence):
                    evidence.append(SequenceEvidence(
                        self.sequence[predicted], [m.id for _, m in anchors],
                        "horizontal" if axis == 0 else "vertical",
                        any(offset < 0 for offset, _ in anchors) and any(offset > 0 for offset, _ in anchors),
                    ))
        return evidence


@dataclass
class MarkerInference:
    outcome: Outcome
    original_label: str | None
    original_status: Status
    original_issues: list[str]
    proposed_label: str | None
    score: float
    supporting_ids: list[str]
    reason: str
    resolved_issues: list[str]

    def to_dict(self) -> dict[str, object]:
        return {
            "outcome": self.outcome,
            "original": {
                "label": self.original_label, "status": self.original_status, "issues": self.original_issues,
            },
            "proposedLabel": self.proposed_label, "score": self.score,
            "supportingIds": self.supporting_ids, "reason": self.reason,
            "resolvedIssues": self.resolved_issues,
        }


@dataclass
class PageRefinement:
    markers: list[IslandMarker]
    page_type: PageLabelType

    def to_dict(self) -> dict[str, object]:
        return {
            **self.page_type.to_dict(),
            "outcomes": dict(Counter(m.inference.outcome for m in self.markers if m.inference)),
        }


class IslandContextRefiner:
    def __init__(self) -> None:
        self.type_inferer = PageTypeInferer()

    @staticmethod
    def visual_support(marker: IslandMarker, label: str, family: str) -> float:
        readings: list[tuple[str, float]] = []
        if marker.label is not None:
            readings.append((marker.label, marker.recognition_score or 0))
        for alternative in marker.alternatives:
            text, score = alternative.get("label"), alternative.get("score")
            if (isinstance(text, str) and isinstance(score, (int, float))
                    and math.isfinite(score) and 0 <= score <= 1
                    and alternative.get("rotation") == marker.rotation):
                readings.append((unicodedata.normalize("NFC", text), float(score)))
        support = 0.0
        for text, score in readings:
            if not valid_label(text):
                continue
            if text == label:
                support = max(support, score)
            elif family in ("uppercase", "lowercase") and text.isascii() and text.lower() == label.lower():
                support = max(support, score * 0.9)
            elif family in ("hiragana", "katakana") and abs(ord(text) - ord(label)) == 0x60:
                support = max(support, score * 0.9)
        return support

    def refine(self, markers: list[IslandMarker]) -> PageRefinement:
        if any(m.inference is not None for m in markers):
            raise ValueError("Context refinement requires original stage-1 markers, not refined output")
        page_type = self.type_inferer.infer(markers)
        refined = deepcopy(markers)
        neighborhood = MarkerNeighborhood(markers, page_type.label_type) if page_type.label_type else None
        for original, marker in zip(markers, refined):
            outcome: Outcome = "unresolved"
            reason = "no_reliable_local_sequence"
            proposal = None
            score = 0.0
            supporting: list[str] = []
            resolved: list[str] = []
            if marker.status == "not_run":
                outcome, reason = "skipped", "ocr_not_run"
            elif neighborhood is None:
                reason = "page_type_undetermined"
            else:
                family = page_type.label_type
                if marker.label is not None and label_family(marker.label) != family:
                    if "script_outlier" not in marker.issues:
                        marker.issues.append("script_outlier")
                    marker.status = "needs_review"
                if marker.status == "recognized":
                    outcome, reason = "not_needed", "reliable_ocr_in_page_type"
                else:
                    evidence = neighborhood.infer(original)
                    labels = {item.label for item in evidence}
                    if len(labels) > 1:
                        reason = "conflicting_local_sequences"
                    elif evidence and family is not None:
                        best = max(evidence, key=lambda item: (item.bracketed, len(item.supporting_ids)))
                        proposal, supporting = best.label, best.supporting_ids
                        visual = self.visual_support(original, proposal, family)
                        enough = (
                            best.bracketed and (visual >= 0.45 or len(supporting) >= 3)
                        ) or (len(supporting) >= 2 and visual >= 0.5)
                        score = round(min(0.98, 0.80 + 0.03 * min(len(supporting), 4) + 0.06 * visual), 6)
                        reason = f"{best.axis}_sequence" if enough else "sequence_without_enough_visual_support"
                        if enough:
                            marker.label = proposal
                            outcome = "confirmed" if proposal == original.label else "corrected"
                            resolved = sorted(set(marker.issues) & TEXT_ISSUES)
                            marker.issues = [issue for issue in marker.issues if issue not in TEXT_ISSUES]
                            marker.status = "needs_review" if marker.issues else "recognized"
            marker.inference = MarkerInference(
                outcome, original.label, original.status, list(original.issues),
                proposal, score, supporting, reason, resolved,
            )
        LOGGER.info(
            "Island context: type=%s vote_share=%.3f outcomes=%s",
            page_type.label_type, page_type.confidence,
            dict(Counter(m.inference.outcome for m in refined if m.inference)),
        )
        return PageRefinement(refined, page_type)
