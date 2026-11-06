export interface CronSchedule {
  readonly expression: string;
}

// A schedule, optionally with a query string the run carries (`?job=backup`), like a Vercel cron path.
export type ScheduleSpec = CronSchedule | { readonly cron: CronSchedule; readonly query?: Readonly<Record<string, string>> };

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day-of-week", min: 0, max: 7, names: DAYS },
];

// Standard five-field cron in UTC: minute hour day-of-month month day-of-week.
export function cron(strings: TemplateStringsArray, ...values: unknown[]): CronSchedule {
  if (values.length) throw new Error("cron`...` takes a fixed expression, without ${} substitutions");
  return Object.freeze({ expression: normalizeCron(strings.raw
    .map((s) => s.trim())
    .join(""))
  });
}

export function normalizeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron "${expression.trim()}": expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}; seconds are not supported`,
    );
  }
  fields.forEach((field, index) => parseField(field, FIELDS[index]!));
  const [, , dayOfMonth, month] = fields as [string, string, string, string, string];
  if (/^(2|FEB)$/i.test(month) && /^\d+$/.test(dayOfMonth) && Number(dayOfMonth) > 29) {
    throw new Error(`Invalid cron "${expression.trim()}": February never has day ${dayOfMonth}`);
  }
  return fields.join(" ");
}

function parseField(field: string, spec: FieldSpec): void {
  for (const part of field.split(",")) {
    const match = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`Invalid cron ${spec.name} "${field}"`);
    if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > spec.max)) {
      throw new Error(`Invalid cron ${spec.name} step in "${field}": expected 1-${spec.max}`);
    }
    if (match[1] === "*") continue;
    const [low, high] = match[1]!.split("-").map((value) => valueOf(value, spec, field));
    if (high !== undefined && low! > high) throw new Error(`Invalid cron ${spec.name} range "${field}"`);
  }
}

function valueOf(token: string, spec: FieldSpec, field: string): number {
  const named = spec.names?.indexOf(token.toUpperCase() as never) ?? -1;
  const value = named >= 0 ? named + (spec.name === "month" ? 1 : 0) : /^\d+$/.test(token) ? Number(token) : NaN;
  if (!(value >= spec.min && value <= spec.max)) {
    throw new Error(`Invalid cron ${spec.name} "${field}": ${token} is outside ${spec.min}-${spec.max}`);
  }
  return value;
}

// EventBridge needs a year field and `?` in one day field.
export function toEventBridgeCron(expression: string): string {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = normalizeCron(expression).split(" ") as [string, string, string, string, string];
  const days = expandDaysOfWeek(dayOfWeek);
  if (days?.size === 0) throw new Error(`Invalid cron "${expression}": day-of-week "${dayOfWeek}" matches no day`);
  const weekRestricted = days !== undefined && days.size < 7;
  const monthRestricted = dayOfMonth !== "*" && dayOfMonth !== "?";
  if (monthRestricted && weekRestricted) {
    throw new Error(`Invalid cron "${expression}": EventBridge cannot restrict both day-of-month and day-of-week`);
  }
  return `cron(${[
    startAt(minute, 0),
    startAt(hour, 0),
    weekRestricted ? "?" : startAt(dayOfMonth, 1),
    startAt(month, 1).toUpperCase(),
    weekRestricted ? renderDays(days!) : "?",
    "*",
  ].join(" ")})`;
}

const startAt = (field: string, start: number) =>
  field
    .split(",")
    .map((part) => (part.startsWith("*/") ? `${start}${part.slice(1)}` : part))
    .join(",");

function expandDaysOfWeek(field: string): Set<number> | undefined {
  if (field === "*" || field === "?") return undefined;
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const [range, step] = part.split("/") as [string, string | undefined];
    const [first, last] = range.split("-").map((token) => {
      const named = DAYS.indexOf(token.toUpperCase() as never);
      return named >= 0 ? named : Number(token);
    }) as [number, number | undefined];
    const from = range === "*" ? 0 : first;
    const to = range === "*" ? 6 : step && last === undefined ? 7 : (last ?? first);
    for (let day = from; day <= to; day += Number(step ?? 1)) days.add(day % 7);
  }
  return days;
}

function renderDays(days: Set<number>): string {
  const numbers = [...days].map((day) => day + 1).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j++;
    parts.push(j - i >= 2 ? `${numbers[i]}-${numbers[j]}` : numbers.slice(i, j + 1).join(","));
    i = j + 1;
  }
  return parts.join(",");
}

// A no-op at runtime; `cloudgear generate` reads it and deploys a scheduled trigger for the method.
export function schedule(_when: ScheduleSpec | readonly ScheduleSpec[]) {
  return (_method: unknown, _context: ClassMethodDecoratorContext): void => {};
}
