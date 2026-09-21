#!/usr/bin/env node
/* =========================================================================
   Night Owl - Kolkata: opening hours.

   OpenStreetMap's opening_hours is a full grammar. This module reads the shapes
   that actually dominate real data and refuses everything else, because a
   confidently wrong "open now" is the one failure a 3 AM directory cannot afford.
   A refusal is not a loss of information: the raw string still ships and is shown
   to the reader verbatim.

   Used by tools/build-locations.mjs and exercised by tools/verify-dataset.mjs.
   The browser has its own copy of the window comparison in assets/app.js, which
   the verification pass checks in a real page instead of by reading it.
   ========================================================================= */

export const DAY_INDEX = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
export const DAY_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const fmtClock = (minutes) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** "Mo-Fr" | "Mo,We,Fr" | "Mo-Fr,Sa" | "PH,Mo-Sa" -> Set of day indices, or null. */
export function parseDaySpec(spec) {
  const days = new Set();
  for (const tokenRaw of spec.split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    if (/^ph$/i.test(token)) continue;            // public holidays: not a weekday
    const range = token.match(/^([a-z]{2})\s*-\s*([a-z]{2})$/i);
    if (range) {
      const from = DAY_INDEX[range[1].toLowerCase()];
      const to = DAY_INDEX[range[2].toLowerCase()];
      if (from === undefined || to === undefined) return null;
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === to) break;
        if (days.size > 7) return null;           // malformed wrap
      }
      continue;
    }
    // "Mo[1]" (first Monday of the month) is not modelled.
    const single = token.match(/^([a-z]{2})(\[\d.*\])?$/i);
    if (!single || single[2]) return null;
    const idx = DAY_INDEX[single[1].toLowerCase()];
    if (idx === undefined) return null;
    days.add(idx);
  }
  return days.size ? days : null;
}

const TIME_RANGE = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/;

/**
 * Parse an opening_hours value.
 * Returns { always: true } | { open, close, closedDays, sameEveryDay, daySummary }
 * | null when it cannot be read safely.
 */
export function parseOsmHours(raw) {
  if (!raw) return null;
  const value = raw.replace(/"[^"]*"/g, '').trim();   // drop quoted comments
  if (!value) return null;

  if (/^24\/7$/i.test(value)) return { always: true };
  if (/^(mo\s*-\s*su\s+)?00:00\s*-\s*24:00$/i.test(value)) return { always: true };

  // Read every rule first: they must all agree on the time window, otherwise (a
  // split shift, say) a single open/close pair would report a serving place shut.
  const rules = [];
  const shutDays = new Set();                       // from "Su off" style rules
  for (const chunk of value.split(';')) {
    const rule = chunk.trim();
    if (!rule) continue;
    if (/^(ph\s+)?off$/i.test(rule)) continue;        // closed those days: adds no window

    // "Su off" / "Mo,Tu off": a real closure, carried by the same grammar as the
    // windows. Without this the rule reads as unparseable and the whole value is
    // thrown away - which for a six-day shop open till 23:00 means losing a
    // genuinely useful night entry.
    const off = rule.match(/^(.*?)\s+off$/i);
    if (off) {
      const days = parseDaySpec(off[1]);
      if (!days) return null;
      days.forEach((d) => shutDays.add(d));
      continue;
    }

    const match = rule.match(/^([a-z]{2}(?:[-,\s]*[a-z]{2})*(?:\s*,\s*[a-z]{2})*)?\s*(.+)$/i);
    if (!match) return null;

    const dayText = (match[1] || '').trim();
    const timeText = match[2].trim();

    if (/sunrise|sunset|dawn|dusk|\+$/i.test(timeText)) return null;
    const time = timeText.match(TIME_RANGE);
    if (!time) return null;                           // split shifts, "06:", etc.

    const days = dayText ? parseDaySpec(dayText) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    rules.push({ days, open: time[1], close: time[2] });
  }
  if (!rules.length) return null;

  const distinct = new Set(rules.map((r) => `${r.open}-${r.close}`));
  if (distinct.size > 1) return null;

  // 24:00 is midnight; the app reads close <= open as a window that wraps.
  const open = rules[0].open.padStart(5, '0');
  const close = rules[0].close === '24:00' ? '00:00' : rules[0].close.padStart(5, '0');
  const days = new Set();
  rules.forEach((r) => r.days.forEach((d) => days.add(d)));
  const closedDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !days.has(d) || shutDays.has(d));
  const everyDay = days.size === 7 && shutDays.size === 0;

  return {
    open,
    close,
    closedDays,
    sameEveryDay: everyDay,
    daySummary: everyDay ? 'daily'
      : `closed ${closedDays.map((d) => DAY_LABEL[d]).join(', ')}`
  };
}

/** Is the parsed window open at a minute of the day, ignoring weekdays? null = unknown. */
export function openAtMinute(parsed, minute) {
  if (!parsed) return null;
  if (parsed.always) return true;
  const open = toMin(parsed.open);
  const close = toMin(parsed.close);
  return close <= open ? (minute >= open || minute < close) : (minute >= open && minute < close);
}

/**
 * Does the mapped window touch the night at all (21:00 - 07:00)?
 * null means "cannot tell": no hours mapped, or too complex to read.
 */
export function nightRelevant(parsed) {
  if (!parsed) return null;
  if (parsed.always) return true;
  const open = toMin(parsed.open);
  const close = toMin(parsed.close);
  const end = close <= open ? close + 1440 : close;
  return (open < 1860 && end > 1260) || (open < 420 && end > -180);
}
