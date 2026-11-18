import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { experienceSpan, parseYearMonth } from './_talentProfiles.ts'

const NOW = new Date(2026, 10, 18) // November 2026

Deno.test('dates as the profile stores them, and other shapes', () => {
  assertEquals(parseYearMonth('2021'), { year: 2021, month: null })
  assertEquals(parseYearMonth('2021-03'), { year: 2021, month: 3 })
  assertEquals(parseYearMonth('03/2021'), { year: 2021, month: 3 })
  assertEquals(parseYearMonth('Mar 2021'), { year: 2021, month: 3 })
  assertEquals(parseYearMonth(''), null)
})

Deno.test('years only (the form today): rounded up to whole years', () => {
  // 2019–2021 = Jan 2019 … Dec 2021 = 3 years
  assertEquals(experienceSpan([{ startDate: '2019', endDate: '2021' }], NOW), { months: 36, approx: true, years: 3 })
  // since 2020, still there: Jan 2020 … Nov 2026 = 83 months → 7 years
  assertEquals(experienceSpan([{ startDate: '2020', current: true }], NOW).years, 7)
})

Deno.test('with months: exact, and overlapping jobs count once', () => {
  const span = experienceSpan([
    { startDate: '2020-01', endDate: '2022-06' },   // 30 months
    { startDate: '2021-01', endDate: '2021-12' },   // inside the first one
    { startDate: '2023-03', endDate: '2023-05' },   // 3 months after a gap
  ], NOW)
  assertEquals(span, { months: 33, approx: false, years: 2 })
})

Deno.test('nothing usable → 0', () => {
  assertEquals(experienceSpan(null, NOW).months, 0)
  assertEquals(experienceSpan([{ title: 'x' }, { startDate: '2020' }], NOW).months, 0) // no end, not current
})

import { filterParams, matchedSkills } from './_talentProfiles.ts'

Deno.test('each chosen value goes with its spellings and translation', () => {
  const f = filterParams(
    { selectedSkills: ['React', 'ניהול פרויקטים', 'C#'], selectedLanguages: ['אנגלית'], selectedLocation: 'Jerusalem, Israel', selectedFieldOfStudy: 'מדעי המחשב' },
    { 'ניהול פרויקטים': 'Project Management', 'אנגלית': 'English', Jerusalem: 'ירושלים', 'מדעי המחשב': 'Computer Science' },
  )
  const react = f.p_skills[0].split('|')
  assertEquals(react.includes('react') && react.includes('reactjs'), true)
  assertEquals(f.p_skills[1].split('|').sort(), ['projectmanagement', 'ניהולפרויקטים'].sort())
  assertEquals(f.p_skills[2].split('|').includes('csharp') && f.p_skills[2].split('|').includes('c#'), true)
  assertEquals(f.p_languages, ['אנגלית|english'])
  assertEquals([f.p_location_alt, f.p_field_alt], ['ירושלים', 'Computer Science'])
  // without translations (the weekly e-mail): spellings only
  assertEquals(filterParams({ selectedSkills: ['Node.js'] }).p_skills[0].split('|').includes('node'), true)
})

Deno.test('matched skills: in the candidate\'s own spelling, any variant', () => {
  assertEquals(matchedSkills(['React.js', 'ניהול פרויקטים', 'Excel'], ['react|reactjs', 'projectmanagement|ניהולפרויקטים']), ['React.js', 'ניהול פרויקטים'])
})
