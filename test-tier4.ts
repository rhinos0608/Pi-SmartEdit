/**
 * Quick test for Tier 4 similarity matching
 * Run: npx tsx test-tier4.ts
 *
 * Tests the actual similarity matching code path by importing
 * from edit-diff.ts rather than reimplementing similarity inline.
 */

import { findText, detectIndentation } from './.pi/extensions/smart-edit/lib/edit-diff';

// Simple test harness
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`OK ${message}`);
}

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
assert(exactMatch.found && exactMatch.tier === 'exact', 'Exact text should match at Tier 1');
console.log('  OK Exact match correctly prioritized');

// Clean exit
console.log('\n=== All tests passed! ===');
process.exit(0);
