import {test} from 'node:test';import assert from 'node:assert/strict';import {addBusinessMinutes,businessMinutesBetween,urgentDayBudget} from '../src/calendar.mjs';
const t=s=>Date.parse(s+'+05:30');
test('Friday 18:00 plus two business hours',()=>assert.equal(addBusinessMinutes(t('2026-11-20T18:00'),120),t('2026-11-23T11:00')));
test('holiday skipped',()=>assert.equal(addBusinessMinutes(t('2026-11-20T18:00'),120,new Set(['2026-11-23'])),t('2026-11-24T11:00')));
test('weekend elapsed excluded',()=>assert.equal(businessMinutesBetween(t('2026-11-20T18:00'),t('2026-11-22T12:00')),30));
test('exact closing boundary',()=>assert.equal(addBusinessMinutes(t('2026-11-20T17:30'),60),t('2026-11-20T18:30')));
test('urgent effective day',()=>assert.equal(urgentDayBudget(t('2026-11-20T19:00')),540));
test('negative rejected',()=>assert.throws(()=>addBusinessMinutes(0,-1)));
