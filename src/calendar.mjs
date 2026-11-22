// Asia/Kolkata fixed UTC+05:30; intentionally rejects other zones until adapted.
const MIN=60000, DAY=86400000, OFFSET=330*MIN, OPEN=570*MIN, CLOSE=1110*MIN;
function dayStart(t){return Math.floor((t+OFFSET)/DAY)*DAY-OFFSET;}
function eligible(d,holidays){const local=new Date(d+OFFSET);return ![0,6].includes(local.getUTCDay())&&!holidays.has(local.toISOString().slice(0,10));}
function validate(t){if(!Number.isFinite(t))throw new TypeError('Invalid timestamp');}
export function addBusinessMinutes(start,minutes,holidays=new Set()){
 validate(start);if(!Number.isFinite(minutes)||minutes<0)throw new RangeError('Invalid budget');
 if(minutes===0)return start; let remaining=minutes*MIN,t=start;
 while(remaining>0){const d=dayStart(t),a=Math.max(t,d+OPEN),b=d+CLOSE;
 if(eligible(d,holidays)&&a<b){if(remaining<=b-a)return a+remaining;remaining-=b-a;}t=d+DAY;}
 return t;
}
export function businessMinutesBetween(start,end,holidays=new Set()){
 validate(start);validate(end);if(end<start)throw new RangeError('Reversed interval');let total=0;
 for(let d=dayStart(start);d<end;d+=DAY)if(eligible(d,holidays))total+=Math.max(0,Math.min(end,d+CLOSE)-Math.max(start,d+OPEN));return total/MIN;
}
export function urgentDayBudget(start,holidays=new Set()){
 validate(start);for(let d=dayStart(start);;d+=DAY){const a=Math.max(start,d+OPEN);if(eligible(d,holidays)&&a<d+CLOSE)return (d+CLOSE-a)/MIN;}
}
