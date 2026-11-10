from dataclasses import dataclass, field
from typing import Literal

from booth_recognition.recognizer import Booth
from island_recognition import IslandMarker
from map_recognition.common import Box


@dataclass
class ContactComponent:
    id: str
    booths: list[Booth]
    bbox: Box
    axis: Literal["horizontal", "vertical"]
    thin: bool

    @property
    def numbers(self) -> set[int]:
        return {int(b.number) for b in self.booths if b.number is not None}

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id, "boothIds": [b.id for b in self.booths],
            "bbox": self.bbox.to_dict(), "axis": self.axis, "thin": self.thin,
        }


@dataclass(frozen=True)
class ComponentLink:
    left: int
    right: int
    weight: int
    kind: str


@dataclass
class IslandSeed:
    id: str
    label: str | None
    markers: list[IslandMarker]
    color: str
    wraps: bool = False


@dataclass
class BoothMembership:
    island_id: str
    component_id: str
    status: Literal["assigned", "needs_review"]
    issues: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "islandId": self.island_id, "componentId": self.component_id,
            "status": self.status, "issues": self.issues,
        }


@dataclass
class AssignedIsland:
    id: str
    label: str | None
    color: str
    marker_ids: list[str]
    booth_ids: list[str]
    component_ids: list[str]
    numbers: list[str]
    issues: list[str]
    number_gaps: list[dict[str, str]]

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id, "label": self.label, "color": self.color,
            "markerIds": self.marker_ids, "blockIds": self.component_ids, "numbers": self.numbers,
            "numberRange": {"first": self.numbers[0], "last": self.numbers[-1]},
            "numberGaps": self.number_gaps,
            "status": "needs_review" if self.issues else "assigned", "issues": self.issues,
        }


@dataclass
class AssignmentResult:
    memberships: dict[str, BoothMembership]
    islands: list[AssignedIsland]
    components: list[ContactComponent]
    excluded: list[Booth]
    solver_status: str
    objective: float
    link_count: int
    wall_link_count: int

    def to_dict(self) -> dict[str, object]:
        return {
            "method": "contact-components-cp-sat",
            "solverStatus": self.solver_status, "objective": self.objective,
            "counts": {
                "assignedBooths": len(self.memberships), "islands": len(self.islands),
                "contactComponents": len(self.components), "excludedCandidates": len(self.excluded),
                "reviewBooths": sum(m.status == "needs_review" for m in self.memberships.values()),
                "numberGaps": sum(len(island.number_gaps) for island in self.islands),
            },
            "constraints": {
                "allBoothsAssigned": True, "touchingBoothsTogether": True,
                "uniqueNumbers": True,
                "continuousNumbers": not any(island.number_gaps for island in self.islands),
            },
            "topology": {"links": self.link_count, "wallTurnLinks": self.wall_link_count},
            "assignmentReviews": {
                booth_id: membership.issues for booth_id, membership in self.memberships.items()
                if membership.status == "needs_review"
            },
            "islands": [island.to_dict() for island in self.islands],
        }
