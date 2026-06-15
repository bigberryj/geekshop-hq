/**
 * Public booking slot generation.
 * Defaults: Mon-Fri, 10am-6pm, 90 minute slots.
 */

const DEFAULT_TZ = 'America/Vancouver';

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function labelFor(date, timeZone = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date).replace(',', '');
}

function isoLocal(base, hour, minute = 0) {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

export function buildAvailableSlots({
  now = new Date(),
  days = 14,
  appointments = [],
  workdayStartHour = 10,
  workdayEndHour = 18,
  slotMinutes = 90,
  maxSlots = 30,
  timeZone = DEFAULT_TZ,
} = {}) {
  const slots = [];
  const conflicts = appointments.map((a) => ({
    start: new Date(a.starts_at),
    end: new Date(a.ends_at),
  }));

  const startDay = new Date(now);
  startDay.setHours(0, 0, 0, 0);

  for (let dayOffset = 0; dayOffset < days && slots.length < maxSlots; dayOffset += 1) {
    const day = new Date(startDay);
    day.setDate(startDay.getDate() + dayOffset);
    const weekday = day.getDay();
    if (weekday === 0 || weekday === 6) continue;

    const dayEnd = isoLocal(day, workdayEndHour);
    for (let cursor = isoLocal(day, workdayStartHour); cursor < dayEnd && slots.length < maxSlots;) {
      const end = new Date(cursor.getTime() + slotMinutes * 60_000);
      if (end > dayEnd) break;
      if (cursor >= now && !conflicts.some((c) => overlaps(cursor, end, c.start, c.end))) {
        slots.push({
          starts_at: cursor.toISOString(),
          ends_at: end.toISOString(),
          label: labelFor(cursor, timeZone),
        });
      }
      cursor = new Date(cursor.getTime() + slotMinutes * 60_000);
    }
  }

  return slots;
}
