import { parseCronExpression } from "@getpaseo/protocol/schedule/cron-expression";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";

interface CronDateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

const CRON_SEARCH_YEARS = 8;

function startOfNextMinute(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes() + 1,
      0,
      0,
    ),
  );
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid cron time zone: ${timeZone}`);
  }
}

function createCronDatePartsReader(timeZone: string | undefined): (date: Date) => CronDateParts {
  if (timeZone === undefined) {
    return (date: Date) => ({
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dayOfMonth: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dayOfWeek: date.getUTCDay(),
    });
  }

  assertValidTimeZone(timeZone);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (date: Date) => {
    const values: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") {
        values[part.type] = part.value;
      }
    }

    const year = Number.parseInt(values.year, 10);
    const month = Number.parseInt(values.month, 10);
    const dayOfMonth = Number.parseInt(values.day, 10);

    return {
      minute: Number.parseInt(values.minute, 10),
      hour: Number.parseInt(values.hour, 10),
      dayOfMonth,
      month,
      dayOfWeek: new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay(),
    };
  };
}

export function validateScheduleCadence(cadence: ScheduleCadence): void {
  if (cadence.type === "cron") {
    parseCronExpression(cadence.expression);
    if (cadence.timezone !== undefined) {
      assertValidTimeZone(cadence.timezone);
    }
  }
}

export function computeNextRunAt(cadence: ScheduleCadence, after: Date): Date {
  if (cadence.type === "every") {
    // COMPAT(scheduleEveryMs): execute legacy persisted rolling intervals until the
    // compatibility floor reaches v0.2.0. Added in v0.2.0; remove after 2027-01-17.
    return new Date(after.getTime() + cadence.everyMs);
  }

  const cron = parseCronExpression(cadence.expression);
  const readDateParts = createCronDatePartsReader(cadence.timezone);
  // Bounded by time, not iterations: Feb 29 can be 8 years away (2096 to 2104).
  const searchEnd = after.getTime() + CRON_SEARCH_YEARS * 366 * 24 * 60 * 60_000;
  let cursor = startOfNextMinute(after);

  while (cursor.getTime() <= searchEnd) {
    const { minute, hour, dayOfMonth, month, dayOfWeek } = readDateParts(cursor);
    const dayMatches = cron.dayOfMonth.matches(dayOfMonth) && cron.dayOfWeek.matches(dayOfWeek);

    let skipMinutes = 1;
    if (!cron.month.matches(month) || !dayMatches) {
      // Toward the next local midnight, stopping 3 hours short so a DST shift during the jump
      // can't carry it past midnight; the rest goes an hour at a time.
      const minutesToMidnight = 24 * 60 - (hour * 60 + minute);
      skipMinutes = minutesToMidnight > 180 ? minutesToMidnight - 180 : 60 - minute;
    } else if (!cron.hour.matches(hour)) {
      skipMinutes = 60 - minute;
    } else if (cron.minute.matches(minute)) {
      return cursor;
    }

    cursor = new Date(cursor.getTime() + skipMinutes * 60_000);
  }

  throw new Error(`Unable to compute next run time for cron expression: ${cadence.expression}`);
}
