import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePreviewData } from '../../client/src/preview/data.ts'
import { numberGapAnnotations, numberGapLabelBox } from '../../client/src/preview/assignmentLayers.ts'
import { parsePathGraph } from '../../client/src/preview/pathGraph.ts'

test('path overlay accepts only in-bounds axis-aligned segments for the matching PDF image', () => {
  const graph = { width: 40, height: 20, segments: [[1, 2, 19, 2], [19, 2, 19, 14]] }
  assert.deepEqual(parsePathGraph(graph, 40, 20), graph.segments)
  assert.throws(() => parsePathGraph(graph, 39, 20))
  for (const segment of [[1, 2, 19, 3], [1, 2, 1, 2], [1, 2, 40, 2], [1.5, 2, 19, 2]]) {
    assert.throws(() => parsePathGraph({ ...graph, segments: [segment] }, 40, 20))
  }
})

function fixture() {
  return {
    schemaVersion: 2,
    coordinateSystem: { origin: 'top-left', unit: 'source-image-pixel' },
    pages: [{
      page: 1, width: 200, height: 150, image: 'page-001.png', booths: [],
      islandMarkers: [
        { id: 'i1', bbox: { x: 10, y: 20, width: 24, height: 30 }, color: '#22b573',
          label: 'ア', status: 'recognized', recognitionScore: 0.98, issues: [] },
        { id: 'i2', bbox: { x: 80, y: 20, width: 24, height: 30 }, color: '#22b573',
          label: 'ア', status: 'needs_review', recognitionScore: 0.7, issues: ['low_confidence'] },
      ],
    }],
  }
}

test('preview keeps repeated island occurrences and case/kana distinctions', () => {
  const data = fixture()
  for (const label of ['A', 'a', 'あ', 'ア']) {
    data.pages[0].islandMarkers[0].label = label
    assert.equal(parsePreviewData(data)[0].islandMarkers?.[0].label, label)
  }
  assert.equal(parsePreviewData(data)[0].islandMarkers?.length, 2)
})

test('preview handles legacy booth-only output explicitly', () => {
  const data = fixture()
  const legacy = { ...data, schemaVersion: 1, pages: data.pages.map(({ islandMarkers: _, ...page }) => page) }
  assert.equal(parsePreviewData(legacy)[0].islandMarkers, null)
  assert.equal(parsePreviewData(legacy)[0].venue, null)
})

test('preview retains venue OCR metadata and rejects invalid or inconsistent states', () => {
  const data = fixture()
  const venue = {
    label: '東123', rawText: 'ComicMarket109 1日目 東123ホール',
    recognitionScore: 0.98, status: 'recognized', issues: [] as string[],
  }
  const withVenue = (value: unknown) => ({
    ...data, pages: data.pages.map(page => ({ ...page, venue: value })),
  })
  assert.deepEqual(parsePreviewData(withVenue(venue))[0].venue, venue)
  assert.equal(parsePreviewData(withVenue({
    ...venue, status: 'needs_review', issues: ['low_confidence'],
  }))[0].venue?.status, 'needs_review')
  assert.equal(parsePreviewData(withVenue({
    label: null, rawText: null, recognitionScore: null, status: 'not_run', issues: [],
  }))[0].venue?.label, null)
  assert.equal(parsePreviewData(withVenue({
    label: null, rawText: '東3/E3', recognitionScore: null, status: 'unrecognized', issues: ['venue_not_found'],
  }))[0].venue?.status, 'unrecognized')
  for (const invalid of [
    { ...venue, label: '東0' }, { ...venue, recognitionScore: NaN }, { ...venue, label: null },
    { ...venue, status: 'unrecognized' }, { ...venue, issues: ['low_confidence'] },
    { ...venue, status: 'needs_review' }, null,
  ]) {
    assert.throws(() => parsePreviewData(withVenue(invalid)), /场馆编号/)
  }
})

test('preview rejects malformed or unsafe island markers', () => {
  for (const mutate of [
    (data: ReturnType<typeof fixture>) => { data.pages[0].islandMarkers[0].bbox.x = -1 },
    (data: ReturnType<typeof fixture>) => { data.pages[0].islandMarkers[0].bbox.width = 500 },
    (data: ReturnType<typeof fixture>) => { data.pages[0].islandMarkers[0].label = 'AB' },
    (data: ReturnType<typeof fixture>) => { data.pages[0].islandMarkers[0].color = 'red' },
    (data: ReturnType<typeof fixture>) => { data.pages[0].islandMarkers[0].recognitionScore = NaN },
    (data: ReturnType<typeof fixture>) => { data.pages[0].islandMarkers[1].id = 'i1' },
  ]) {
    const data = fixture()
    mutate(data)
    assert.throws(() => parsePreviewData(data))
  }
  const data = fixture()
  assert.throws(() => parsePreviewData({ ...data, pages: data.pages.map(({ islandMarkers: _, ...page }) => page) }))
})

function refinedFixture() {
  const data = fixture()
  return {
    ...data, schemaVersion: 3,
    pages: data.pages.map(page => ({
      ...page,
      islandInference: {
        type: 'katakana', confidence: 1,
        votes: { uppercase: 0, lowercase: 0, hiragana: 0, katakana: 3 },
        counts: { uppercase: 0, lowercase: 0, hiragana: 0, katakana: 3 },
        distinctLabels: { uppercase: 0, lowercase: 0, hiragana: 0, katakana: 3 },
        reason: 'distinct_label_consensus', outcomes: { not_needed: 1, corrected: 1 },
      },
      islandMarkers: page.islandMarkers.map((marker, index) => ({
        ...marker,
        inference: {
          outcome: index === 0 ? 'not_needed' : 'corrected',
          original: { label: index === 0 ? 'ア' : 'A', status: marker.status, issues: marker.issues },
          proposedLabel: index === 0 ? null : 'ア',
          score: index === 0 ? 0 : 0.94, supportingIds: index === 0 ? [] : ['i1'],
          reason: index === 0 ? 'reliable_ocr_in_page_type' : 'horizontal_sequence',
          resolvedIssues: index === 0 ? [] : ['low_confidence', 'script_outlier'],
        },
      })),
    })),
  }
}

test('preview renders final context-corrected text and preserves original OCR provenance', () => {
  const page = parsePreviewData(refinedFixture())[0]
  assert.equal(page.islandInference?.type, 'katakana')
  assert.equal(page.islandInference?.outcomes.corrected, 1)
  assert.equal(page.islandMarkers?.[1].label, 'ア')
  assert.equal(page.islandMarkers?.[1].inference?.original.label, 'A')
  assert.equal(page.islandMarkers?.[1].recognitionScore, 0.7)
  assert.equal(parsePreviewData(fixture())[0].islandInference, null)
})

test('preview rejects inconsistent or malformed stage-2 inference metadata', () => {
  for (const mutate of [
    (data: ReturnType<typeof refinedFixture>) => { data.pages[0].islandInference.type = 'unknown' },
    (data: ReturnType<typeof refinedFixture>) => { data.pages[0].islandInference.confidence = NaN },
    (data: ReturnType<typeof refinedFixture>) => { data.pages[0].islandInference.outcomes.corrected = 10 },
    (data: ReturnType<typeof refinedFixture>) => { data.pages[0].islandMarkers[1].inference.proposedLabel = 'あ' },
    (data: ReturnType<typeof refinedFixture>) => { data.pages[0].islandMarkers[1].inference.score = 1.1 },
    (data: ReturnType<typeof refinedFixture>) => { data.pages[0].islandMarkers[1].inference.supportingIds = ['missing'] },
    (data: ReturnType<typeof refinedFixture>) => { data.pages[0].islandMarkers[1].inference.original.label = 'ア' },
    (data: ReturnType<typeof refinedFixture>) => { data.pages[0].islandMarkers[1].inference.outcome = 'success' },
  ]) {
    const data = refinedFixture()
    mutate(data)
    assert.throws(() => parsePreviewData(data))
  }
  assert.throws(() => parsePreviewData({ ...fixture(), schemaVersion: 3 }))
})

function assignedFixture() {
  const data = fixture()
  return {
    ...data, schemaVersion: 4,
    pages: data.pages.map(page => ({
      ...page, width: 400, height: 300,
      booths: ['87', '88', '93'].map((number, index) => ({
        id: `b${index}`, bbox: { x: index * 70 + 20, y: 120, width: 29, height: 41 },
        number, rotation: 0, status: 'recognized', islandId: 's1',
        assignment: { islandId: 's1', componentId: `c${index}`, status: 'assigned', issues: [] },
      })),
      excludedCandidates: [{ id: 'excluded', number: null, status: 'unrecognized' }],
      islandAssignment: {
        solverStatus: 'optimal',
        counts: { assignedBooths: 3, islands: 1, contactComponents: 3, excludedCandidates: 1, reviewBooths: 0, numberGaps: 1 },
        constraints: { allBoothsAssigned: true, touchingBoothsTogether: true, uniqueNumbers: true, continuousNumbers: false },
        components: [0, 1, 2].map(index => ({ id: `c${index}`, boothIds: [`b${index}`] })),
        islands: [{
          id: 's1', label: 'ア', color: '#1177cc', markerIds: ['i1', 'i2'],
          boothIds: ['b0', 'b1', 'b2'], componentIds: ['c0', 'c1', 'c2'],
          numbers: ['87', '88', '93'], numberRange: { first: '87', last: '93' },
          numberGaps: [{ first: '89', last: '92' }], status: 'needs_review', issues: ['numbering_gaps'],
        }],
      },
    })),
  }
}

test('preview reads complete unique island membership and separate missing-number ranges', () => {
  const data = assignedFixture()
  const page = parsePreviewData(data)[0]
  assert.equal(page.booths.length, 3)
  assert.equal(page.islandAssignment?.islands.length, 1)
  assert.equal(page.islandAssignment?.excludedCount, 1)
  assert.equal(page.booths[2].islandId, 's1')
  assert.deepEqual(page.islandAssignment?.islands[0].numberGaps, [{ first: '89', last: '92' }])
})

test('gap annotation derives 93 only in preview and places its label outside the booth', () => {
  const page = parsePreviewData(assignedFixture())[0]
  const before = JSON.stringify(page.booths)
  const annotations = numberGapAnnotations(page)
  assert.equal(annotations.length, 1)
  assert.equal(annotations[0].label, '93')
  assert.equal(annotations[0].booth.id, 'b2')
  const box = annotations[0].booth.bbox
  const label = numberGapLabelBox(page, box, 34, 24)
  assert.ok(label.x >= box.x + box.width || label.x + label.width <= box.x
    || label.y >= box.y + box.height || label.y + label.height <= box.y)
  assert.equal(JSON.stringify(page.booths), before)
  assert.deepEqual(page.booths[2].assignment?.issues, [])
  assert.deepEqual(numberGapAnnotations(parsePreviewData(fixture())[0]), [])
})

test('preview rejects incomplete memberships, duplicates, false exclusions and incorrect gap records', () => {
  for (const mutate of [
    (data: ReturnType<typeof assignedFixture>) => { data.pages[0].booths[0].islandId = 'missing' },
    (data: ReturnType<typeof assignedFixture>) => { data.pages[0].booths[2].number = '88' },
    (data: ReturnType<typeof assignedFixture>) => { data.pages[0].islandAssignment.islands[0].boothIds.pop() },
    (data: ReturnType<typeof assignedFixture>) => { data.pages[0].islandAssignment.islands[0].numberGaps[0].last = '91' },
    (data: ReturnType<typeof assignedFixture>) => { data.pages[0].islandAssignment.counts.assignedBooths = 2 },
    (data: ReturnType<typeof assignedFixture>) => { data.pages[0].islandAssignment.constraints.uniqueNumbers = false },
    (data: ReturnType<typeof assignedFixture>) => { data.pages[0].islandAssignment.constraints.continuousNumbers = true },
    (data: ReturnType<typeof assignedFixture>) => { data.pages[0].excludedCandidates[0].status = 'recognized' },
    (data: ReturnType<typeof assignedFixture>) => { data.pages[0].islandAssignment.components[0].boothIds = ['b0', 'b2'] },
    (data: ReturnType<typeof assignedFixture>) => { data.pages[0].islandAssignment.solverStatus = 'unknown' },
  ]) {
    const data = assignedFixture()
    mutate(data)
    assert.throws(() => parsePreviewData(data))
  }
})
