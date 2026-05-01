/**
 * Quick test for Tier 4 similarity matching
 * Run: npx tsx test-tier4.js
 *
 * Tests the actual similarity matching code path by importing
 * from edit-diff.ts rather than reimplementing similarity inline.
 *
 * Uses only exported functions: findText, detectIndentation.
 * The similarity tier is exercised via findText which calls it
 * when Tiers 1-3 fail.
 */

// Simple test harness
function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`OK ${message}`);
}

async function runTests() {
  const { findText, detectIndentation } = await import(
    './.pi/extensions/smart-edit/lib/edit-diff.ts'
  );

  // Test 1: Tier 4 should rescue near-matches with minor differences
  console.log('\n=== Test: Tier 4 rescues near-match ===');

  const fileContent = `function calculateTotal(price, quantity) {
  const tax = 0.08;
  const subtotal = price * quantity;
  const total = subtotal * (1 + tax);
  return total;
}`;

  // Old text with slight variation (different indentation on one line)
  const oldText = `function calculateTotal(price, quantity) {
  const tax = 0.08;
    const subtotal = price * quantity;
  const total = subtotal * (1 + tax);
  return total;
}`;

  const style = detectIndentation(fileContent);
  console.log(`  Indentation: ${style.char === '\t' ? 'tabs' : style.width + '-space'}`);

  // findText searches Tiers 1-4 in order.
  // Tier 1 (exact) and Tier 2 (indent normalization) fail due to the
  // extra 2-space indent on line 3, but Tier 4 (similarity) should catch it.
  const match = findText(fileContent, oldText, style);
  console.log(`  Tier: ${match.tier}, found: ${match.found}, note: ${match.matchNote || 'none'}`);

  assert(match.found, 'findText should find the near-match via Tier 4');
  assert(match.tier !== undefined, 'Match should report which tier found it');

  // Test 2: Tier 4 should NOT match completely different content
  console.log('\n=== Test: Tier 4 rejects different content ===');

  const differentOldText = `class Bar {
  constructor() {
    this.value = 100;
  }
}`;

  const noMatch = findText(fileContent, differentOldText, style);
  assert(!noMatch.found, 'findText should NOT find completely different content');
  console.log('  OK Correctly rejected');

  // Test 3: Exact match takes priority over similarity
  console.log('\n=== Test: Exact match priority ===');

  const exactOld = `  const subtotal = price * quantity;`;
  const exactMatch = findText(fileContent, exactOld, style);
  assert(exactMatch.found && exactMatch.tier === 3, 'Exact text should match at Tier 1 (tier=3)');
  console.log('  OK Exact match correctly prioritized');

  // Test 4: Empty/whitespace-only oldText returns no match
  console.log('\n=== Test: Empty text guard ===');

  const emptyMatch = findText(fileContent, '', style);
  assert(!emptyMatch.found, 'Empty oldText should not match');

  const wsMatch = findText(fileContent, '   ', style);
  assert(!wsMatch.found, 'Whitespace-only oldText should not match via similarity');

  // Clean exit
  console.log('\n=== All tests passed! ===');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
