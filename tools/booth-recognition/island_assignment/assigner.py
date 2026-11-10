import colorsys
import logging
import math
from collections import Counter
from statistics import median

from ortools.sat.python import cp_model

from booth_recognition.recognizer import Booth, valid_number
from booth_blocks import BlockGroupingResult
from island_recognition import IslandMarker
from island_recognition.recognizer import label_family

from .geometry import ContactGraphBuilder, LayoutTopology, marker_cost
from .models import AssignedIsland, AssignmentResult, BoothMembership, ContactComponent, IslandSeed

LOGGER = logging.getLogger(__name__)


class AssignmentError(ValueError):
    def __init__(self, code: str, message: str, *, details: dict[str, object] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}

    def to_dict(self) -> dict[str, object]:
        return {"code": self.code, "message": str(self), "details": self.details}


def island_seeds(markers: list[IslandMarker], page: int, page_type: str | None) -> list[IslandSeed]:
    groups: dict[str, list[IslandMarker]] = {}
    labels: dict[str, str | None] = {}
    for marker in markers:
        if marker.status == "not_run":
            raise AssignmentError("ocr_not_run", "Island OCR must run before booth assignment")
        label = marker.label
        if label is not None and page_type is not None and label_family(label) != page_type:
            label = None
        key = f"label:{label}" if label is not None else f"unknown:{marker.id}"
        groups.setdefault(key, []).append(marker)
        labels[key] = label
    seeds = []
    for index, (key, occurrences) in enumerate(groups.items(), 1):
        hue = (index * 0.61803398875) % 1
        rgb = colorsys.hls_to_rgb(hue, 0.45, 0.72)
        centers_x = [m.bbox.x + m.bbox.width / 2 for m in occurrences]
        centers_y = [m.bbox.y + m.bbox.height / 2 for m in occurrences]
        glyph_scale = median(max(m.bbox.width, m.bbox.height) for m in occurrences)
        wraps = len(occurrences) >= 3 and min(
            max(centers_x) - min(centers_x), max(centers_y) - min(centers_y),
        ) > glyph_scale * 8
        seeds.append(IslandSeed(
            f"p{page:03}-island-{index:03}", labels[key], occurrences,
            "#" + "".join(f"{round(c * 255):02x}" for c in rgb), wraps,
        ))
    return seeds


def number_gaps(numbers: list[int]) -> list[dict[str, str]]:
    return [
        {"first": f"{a + 1:02}", "last": f"{b - 1:02}"}
        for a, b in zip(numbers, numbers[1:]) if b > a + 1
    ]


def validate_assignment(booths: list[Booth], result: AssignmentResult) -> None:
    if len({b.id for b in booths}) != len(booths):
        raise AssignmentError("duplicate_ids", "Booth IDs must be unique")
    eligible = {b.id: b for b in booths if b.status != "unrecognized"}
    if any(b.number is None or not valid_number(b.number) or b.status == "not_run" for b in eligible.values()):
        raise AssignmentError("invalid_booth_number", "Assignment validation requires recognized two-digit booths")
    if set(result.memberships) != set(eligible):
        raise AssignmentError("incomplete_assignment", "Every recognized booth must have exactly one island")
    seen: set[str] = set()
    island_ids = {island.id for island in result.islands}
    if len(island_ids) != len(result.islands):
        raise AssignmentError("duplicate_ids", "Logical island IDs must be unique")
    for island in result.islands:
        if not island.booth_ids or seen.intersection(island.booth_ids):
            raise AssignmentError("duplicate_membership", "Empty island or repeated booth membership")
        seen.update(island.booth_ids)
        numbers = []
        for booth_id in island.booth_ids:
            booth = eligible.get(booth_id)
            if booth is None or booth.number is None or result.memberships[booth_id].island_id != island.id:
                raise AssignmentError("invalid_membership", "Membership does not refer to an eligible booth/island")
            numbers.append(int(booth.number))
        if len(set(numbers)) != len(numbers):
            raise AssignmentError("duplicate_numbers", f"Island {island.id} has repeated booth numbers")
        if island.numbers != [f"{n:02}" for n in sorted(numbers)]:
            raise AssignmentError("invalid_number_summary", "Island number summary does not match booth OCR")
        if island.number_gaps != number_gaps(sorted(numbers)):
            raise AssignmentError("invalid_gap_summary", "Island missing-number summary does not match booth OCR")
    if seen != set(eligible) or any(m.island_id not in island_ids for m in result.memberships.values()):
        raise AssignmentError("incomplete_assignment", "Island membership is incomplete")
    for component in ContactGraphBuilder().build(list(eligible.values()), 1):
        if len({result.memberships[b.id].island_id for b in component.booths}) != 1:
            raise AssignmentError("contact_split", "Touching booths cannot belong to different islands")
    listed = [b.id for component in result.components for b in component.booths]
    if len(listed) != len(eligible) or set(listed) != set(eligible):
        raise AssignmentError("invalid_components", "Contact components must partition eligible booths")
    for component in result.components:
        if any(result.memberships[b.id].component_id != component.id for b in component.booths):
            raise AssignmentError("invalid_components", "Booth component references do not match contact groups")
    if {b.id for b in result.excluded} != {b.id for b in booths if b.status == "unrecognized"}:
        raise AssignmentError("invalid_exclusions", "Only unrecognized candidates may be excluded")


class BoothIslandAssigner:
    def __init__(self, *, time_limit: float = 30) -> None:
        if not math.isfinite(time_limit) or time_limit <= 0:
            raise ValueError("time_limit must be finite and positive")
        self.time_limit = time_limit
        self.contact_builder = ContactGraphBuilder()
        self.topology = LayoutTopology()

    def assign(
        self, booths: list[Booth], markers: list[IslandMarker], *,
        page: int = 1, page_type: str | None = None, blocks: BlockGroupingResult | None = None,
    ) -> AssignmentResult:
        if len({b.id for b in booths}) != len(booths) or len({m.id for m in markers}) != len(markers):
            raise AssignmentError("duplicate_ids", "Booth and marker IDs must be unique")
        if any(b.status == "not_run" for b in booths):
            raise AssignmentError("ocr_not_run", "Booth OCR must run before island assignment")
        eligible = [b for b in booths if b.status != "unrecognized"]
        excluded = [b for b in booths if b.status == "unrecognized"]
        if any(b.number is None or not valid_number(b.number) for b in eligible):
            raise AssignmentError("invalid_booth_number", "Recognized booths must have two-digit numbers")
        components = self.contact_builder.build(booths, page, blocks)
        for component in components:
            if len(component.numbers) != len(component.booths):
                repeats = {n: count for n, count in Counter(b.number for b in component.booths).items() if count > 1}
                raise AssignmentError(
                    "contact_number_conflict", "Touching booths contain repeated numbers; inspect OCR/detection",
                    details={"page": page, "componentId": component.id,
                             "boothIds": [b.id for b in component.booths], "repeatedNumbers": repeats},
                )
        if not eligible:
            result = AssignmentResult({}, [], [], excluded, "no_booths", 0, 0, 0)
            validate_assignment(booths, result)
            return result
        seeds = island_seeds(markers, page, page_type)
        frequency = Counter(b.number for b in eligible)
        if not seeds or max(frequency.values()) > len(seeds):
            raise AssignmentError(
                "insufficient_island_labels", "Not enough distinct island labels for unique booth numbering",
                details={"page": page, "labels": len(seeds), "minimumRequired": max(frequency.values())},
            )
        scale = median(max(b.bbox.width, b.bbox.height) for b in eligible)
        links = self.topology.build(components, scale)
        costs = [[marker_cost(component, seed, scale) for seed in seeds] for component in components]
        model = cp_model.CpModel()
        choices = [model.new_int_var(0, len(seeds) - 1, f"group_{g}") for g in range(len(components))]
        selected = {}
        for g in range(len(components)):
            for k in range(len(seeds)):
                variable = model.new_bool_var(f"x_{g}_{k}")
                selected[g, k] = variable
                model.add(choices[g] == k).only_enforce_if(variable)
            model.add_exactly_one(selected[g, k] for k in range(len(seeds)))
            nearest = min(range(len(seeds)), key=lambda k: costs[g][k])
            model.add_hint(choices[g], nearest)
            for k in range(len(seeds)):
                model.add_hint(selected[g, k], int(k == nearest))
        containing = {
            n: [g for g, component in enumerate(components) if n in component.numbers] for n in range(100)
        }
        for k in range(len(seeds)):
            model.add(sum(selected[g, k] for g in range(len(components))) >= 1)
            for n in range(100):
                if len(containing[n]) > 1:
                    model.add(sum(selected[g, k] for g in containing[n]) <= 1)
        objective = [
            costs[g][k] * selected[g, k] for g in range(len(components)) for k in range(len(seeds))
        ]
        for k in range(len(seeds)):
            first = model.new_int_var(0, 99, f"first_{k}")
            last = model.new_int_var(0, 99, f"last_{k}")
            for g, component in enumerate(components):
                model.add(first <= min(component.numbers)).only_enforce_if(selected[g, k])
                model.add(last >= max(component.numbers)).only_enforce_if(selected[g, k])
            # Prefer short number spans, but preserve genuine gaps in the source map.
            objective.append(200 * (last - first + 1))
        for index, link in enumerate(links):
            different = model.new_bool_var(f"cut_{index}")
            model.add(choices[link.left] != choices[link.right]).only_enforce_if(different)
            model.add(choices[link.left] == choices[link.right]).only_enforce_if(different.negated())
            objective.append(link.weight * different)
        model.minimize(sum(objective))
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.time_limit
        solver.parameters.num_search_workers = 4
        solver.parameters.random_seed = 0
        status = solver.solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            code = "constraints_infeasible" if status == cp_model.INFEASIBLE else "solver_incomplete"
            raise AssignmentError(
                code, "No validated booth-to-island assignment found; no fallback assignment was produced",
                details={"page": page, "solverStatus": solver.status_name(status),
                         "components": len(components), "islands": len(seeds), "timeLimit": self.time_limit},
            )
        memberships: dict[str, BoothMembership] = {}
        island_components: dict[int, list[ContactComponent]] = {k: [] for k in range(len(seeds))}
        for g, component in enumerate(components):
            k = solver.value(choices[g])
            seed = seeds[k]
            issues = []
            if seed.label is None:
                issues.append("unresolved_island_label")
            if any(m.status != "recognized" for m in seed.markers):
                issues.append("island_marker_needs_review")
            if costs[g][k] > min(costs[g]):
                issues.append("global_constraint_choice")
            equal_best = sum(cost <= costs[g][k] for cost in costs[g]) > 1
            if equal_best and costs[g][k] == min(costs[g]):
                issues.append("ambiguous_marker_distance")
            island_components[k].append(component)
            for booth in component.booths:
                booth_issues = issues + (["booth_ocr_needs_review"] if booth.status == "needs_review" else [])
                memberships[booth.id] = BoothMembership(
                    seed.id, component.id, "needs_review" if booth_issues else "assigned", booth_issues,
                )
        islands = []
        for k, seed in enumerate(seeds):
            groups = island_components[k]
            ids = [b.id for group in groups for b in group.booths]
            numbers = sorted(n for group in groups for n in group.numbers)
            issues = sorted({issue for booth_id in ids for issue in memberships[booth_id].issues})
            gaps = number_gaps(numbers)
            if gaps:
                issues.append("numbering_gaps")
            islands.append(AssignedIsland(
                seed.id, seed.label, seed.color, [m.id for m in seed.markers],
                ids, [g.id for g in groups], [f"{n:02}" for n in numbers], issues, gaps,
            ))
        result = AssignmentResult(
            memberships, islands, components, excluded, solver.status_name(status).lower(),
            solver.objective_value, len(links), sum(link.kind == "wall_turn" for link in links),
        )
        validate_assignment(booths, result)
        LOGGER.info(
            "Page %s: assigned %s booths to %s islands; excluded %s unrecognized candidates; solver=%s",
            page, len(memberships), len(islands), len(excluded), result.solver_status,
        )
        return result
