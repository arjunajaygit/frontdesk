import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addBusinessMinutes,businessMinutesBetween,urgentDayBudget} from '../src/calendar.mjs';
const t=s=>Date.parse(s+'+05:30');
test('exact closing start advances to next opening',()=>{
 const start=t('2026-11-20T18:30');
 assert.equal(addBusinessMinutes(start,120),t('2026-11-23T11:30'));
 assert.equal(urgentDayBudget(start),540);
});
test('zero budget returns exact start even out of hours',()=>{
 const start=t('2026-11-21T12:00'); assert.equal(addBusinessMinutes(start,0),start);
});
test('consecutive holidays skip Monday and Tuesday',()=>{
 assert.equal(addBusinessMinutes(t('2026-11-20T18:00'),120,new Set(['2026-11-23','2026-11-24'])),t('2026-11-25T11:00'));
});
test('medium Friday deadline examples',()=>{
 const start=t('2026-11-20T18:00');
 assert.equal(addBusinessMinutes(start,270),t('2026-11-23T13:30'));
 assert.equal(addBusinessMinutes(start,1620),t('2026-11-25T18:00'));
});
test('add and elapsed round trip including single millisecond',()=>{
 const holidays=new Set(['2026-11-23']);
 for (const start of [t('2026-11-20T17:59')+1,t('2026-11-21T12:00'),t('2026-11-20T18:30')]) {
  for(const ms of [0,1,60000,7200000,97200000]) {
   const end=addBusinessMinutes(start,ms/60000,holidays);
   assert.equal(Math.round(businessMinutesBetween(start,end,holidays)*60000),ms);
  }
 }
});
test('pause example: urgent day budget consumed before wait',()=>{
 const start=t('2026-11-23T17:30');const paused=t('2026-11-23T18:00');const resumed=t('2026-11-24T10:00');
 const remaining=urgentDayBudget(start)-businessMinutesBetween(start,paused);
 assert.equal(remaining,30);assert.equal(addBusinessMinutes(resumed,remaining),t('2026-11-24T10:30'));
});
