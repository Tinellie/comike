import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePreviewData } from '../../client/src/preview/data.ts'

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
