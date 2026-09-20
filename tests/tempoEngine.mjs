const DEFAULT_TIME_SIGNATURE = { numerator: 4, denominator: 4 }

function normalizeTimeSignature(timeSignature) {
  const numerator = Math.max(1, Math.round(Number(timeSignature?.numerator) || DEFAULT_TIME_SIGNATURE.numerator))
  const denominator = Number(timeSignature?.denominator) === 8 ? 8 : 4
  return { numerator, denominator }
}

function beatsPerBarFromTimeSignature(timeSignature) {
  const normalized = normalizeTimeSignature(timeSignature)
  return normalized.numerator * (4 / normalized.denominator)
}

function isCompoundTimeSignature(timeSignature) {
  const normalized = normalizeTimeSignature(timeSignature)
  return [6, 9, 12].includes(normalized.numerator)
}

function getInternalBpm(projectBpm, timeSignature) {
  const normalized = normalizeTimeSignature(timeSignature)
  const { numerator, denominator } = normalized
  
  if (isCompoundTimeSignature(timeSignature)) {
    const multiplier = 1.5 * (8 / denominator)
    return projectBpm * multiplier
  } else {
    return projectBpm * (4 / denominator)
  }
}

console.log('🧪 Starting Time Signature and Tempo Engine Tests\n')

const testCases = [
  {
    name: '4/4 time at 120 BPM',
    timeSignature: { numerator: 4, denominator: 4 },
    projectBpm: 120,
    expectedInternalBpm: 120,
    expectedBarsPerMinute: 30
  },
  {
    name: '12/8 time at 112 BPM',
    timeSignature: { numerator: 12, denominator: 8 },
    projectBpm: 112,
    expectedInternalBpm: 168,
    expectedBarsPerMinute: 28
  },
  {
    name: '7/8 time at 140 BPM',
    timeSignature: { numerator: 7, denominator: 8 },
    projectBpm: 140,
    expectedInternalBpm: 70,
    expectedBarsPerMinute: 20
  }
]

let passed = true

testCases.forEach((tc, index) => {
  console.log(`Test ${index + 1}: ${tc.name}`)
  
  const internalBpm = getInternalBpm(tc.projectBpm, tc.timeSignature)
  const beatsPerBar = beatsPerBarFromTimeSignature(tc.timeSignature) // length of bar in internal quarter notes
  
  // Calculate bars per minute based on internal quarter notes
  // Minutes per bar = beatsPerBar / internalBpm
  // Bars per minute = internalBpm / beatsPerBar
  const barsPerMinute = internalBpm / beatsPerBar
  
  console.log(`  Calculated Internal Baseline BPM: ${internalBpm} (Expected: ${tc.expectedInternalBpm})`)
  console.log(`  Calculated Bars Per Minute: ${barsPerMinute} (Expected: ${tc.expectedBarsPerMinute})`)
  
  const bpmOk = Math.abs(internalBpm - tc.expectedInternalBpm) < 0.0001
  const barsOk = Math.abs(barsPerMinute - tc.expectedBarsPerMinute) < 0.0001
  
  if (bpmOk && barsOk) {
    console.log('  ✓ PASS\n')
  } else {
    console.log('  ❌ FAIL\n')
    passed = false
  }
})

if (passed) {
  console.log('🎉 All Tempo Engine Tests Passed!')
  process.exit(0)
} else {
  console.log('❌ Some Tempo Engine Tests Failed!')
  process.exit(1)
}
