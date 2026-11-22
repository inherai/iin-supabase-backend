import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { shownFigure, shownLabel, shownNumber } from './poolNumbers.ts'

Deno.test('small numbers are not shown', () => {
  assertEquals(shownNumber(0), null)
  assertEquals(shownNumber(99), null)
  assertEquals(shownLabel(31, 'he'), null)
})

Deno.test('close below a milestone rounds up with a tilde, otherwise "more than"', () => {
  // milestones every 500 from 1,000; within 10% below the next → about
  assertEquals(shownLabel(3190, 'en'), '~3,500')
  assertEquals(shownLabel(3100, 'he'), 'יותר מ-3,000')
  assertEquals(shownLabel(3149, 'en'), '3,000+')
  assertEquals(shownLabel(3150, 'en'), '~3,500')
  assertEquals(shownLabel(3550, 'he'), 'יותר מ-3,500')
  assertEquals(shownLabel(3600, 'he'), '~4,000')
  assertEquals(shownLabel(4000, 'en'), '4,000')
  // every 100 below 1,000
  assertEquals(shownLabel(613, 'en'), '600+')
  assertEquals(shownLabel(298, 'en'), '~300')
  assertEquals(shownFigure(2257), '~2,500')
  assertEquals(shownFigure(2200), '2,000+')
  assertEquals(shownFigure(219), '200+')
})
