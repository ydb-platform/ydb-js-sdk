/// <reference lib="esnext.temporal" preserve="true" />

export type TimezonePrecision = 'date' | 'datetime' | 'timestamp'

export function getTemporal(): typeof Temporal {
	let temporal = globalThis.Temporal
	if (!temporal)
		throw new Error(
			'Temporal is not available; initialize globalThis.Temporal in your application'
		)
	return temporal
}

function requireTemporalType(value: unknown, name: string): void {
	if (Object.prototype.toString.call(value) !== `[object Temporal.${name}]`)
		throw new TypeError(`Expected Temporal.${name}; convert the input explicitly`)
}

function requireISOCalendar(value: Temporal.PlainDate | Temporal.ZonedDateTime): void {
	if (value.calendarId !== 'iso8601') throw new RangeError('YDB dates require the ISO calendar')
}

function exactUnits(nanoseconds: bigint, unit: bigint, name: string): bigint {
	if (nanoseconds % unit !== 0n)
		throw new RangeError(`YDB ${name} cannot represent the supplied sub-${name} precision`)
	return nanoseconds / unit
}

export function dateToDays(value: Temporal.PlainDate): number {
	requireTemporalType(value, 'PlainDate')
	requireISOCalendar(value)
	return value.since('1970-01-01', { largestUnit: 'days' }).days
}

export function instantToSeconds(value: Temporal.Instant): bigint {
	requireTemporalType(value, 'Instant')
	return exactUnits(value.epochNanoseconds, 1_000_000_000n, 'second')
}

export function instantToMicroseconds(value: Temporal.Instant): bigint {
	requireTemporalType(value, 'Instant')
	return exactUnits(value.epochNanoseconds, 1000n, 'microsecond')
}

export function durationToMicroseconds(value: Temporal.Duration): bigint {
	if (value.years || value.months || value.weeks || value.days)
		throw new RangeError('YDB intervals require time units without calendar units')
	return (
		((BigInt(value.hours) * 60n + BigInt(value.minutes)) * 60n + BigInt(value.seconds)) *
			1_000_000n +
		BigInt(value.milliseconds) * 1000n +
		BigInt(value.microseconds) +
		exactUnits(BigInt(value.nanoseconds), 1000n, 'microsecond')
	)
}

function timezoneParts(text: string) {
	let parts = text.match(
		/^([+-]?\d{1,6})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,6}))?)?,([^,]+)$/
	)
	if (!parts) throw new TypeError('Expected a YDB timezone date followed by an IANA timezone')
	let [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = parts
	let year = Number(yearText)
	if (year === 0) throw new RangeError('YDB dates have no year zero')
	if (Number(secondText) > 59) throw new RangeError('Invalid YDB timezone second')
	// YDB uses historical years; Temporal uses astronomical years including zero.
	if (year < 0) year++
	if (/^[+-]/.test(zone!)) throw new RangeError('YDB dates require an IANA timezone')
	return {
		year,
		month: Number(monthText),
		day: Number(dayText),
		hour: Number(hourText ?? 0),
		minute: Number(minuteText ?? 0),
		second: Number(secondText ?? 0),
		millisecond: Number((fraction ?? '').padEnd(6, '0').slice(0, 3)),
		microsecond: Number((fraction ?? '').padEnd(6, '0').slice(3)),
		timeZone: zone!,
		fraction,
		hasTime: hourText !== undefined,
	}
}

function timezoneDate(
	parts: ReturnType<typeof timezoneParts>,
	temporal: typeof Temporal
): Temporal.ZonedDateTime {
	return temporal.ZonedDateTime.from(parts, { disambiguation: 'reject', overflow: 'reject' })
}

export function parseTimezoneDate(text: string, temporal: typeof Temporal): Temporal.ZonedDateTime {
	let parts = timezoneParts(text)
	if (!parts.hasTime)
		throw new TypeError('YDB timezone dates without time have no Temporal equivalent')
	return timezoneDate(parts, temporal)
}

export function timezoneText(
	value: Temporal.ZonedDateTime | string,
	precision: TimezonePrecision,
	extended: boolean
): string {
	let text: string
	if (typeof value === 'string') {
		text = value
	} else {
		requireISOCalendar(value)
		if (precision !== 'date')
			exactUnits(
				value.epochNanoseconds,
				precision === 'datetime' ? 1_000_000_000n : 1000n,
				precision === 'datetime' ? 'second' : 'microsecond'
			)
		let iso =
			precision === 'date'
				? value.toPlainDate().toString({ calendarName: 'never' })
				: value.toString({
						calendarName: 'never',
						offset: 'never',
						timeZoneName: 'never',
						fractionalSecondDigits: precision === 'timestamp' ? 6 : 0,
					})
		let year = value.year <= 0 ? value.year - 1 : value.year
		text = iso.replace(/^[+-]?\d+/, String(year)) + ',' + value.timeZoneId
	}
	let parts = timezoneParts(text)
	if (
		(precision === 'date') === parts.hasTime ||
		(precision !== 'timestamp' && parts.fraction !== undefined)
	) {
		throw new TypeError(`Timezone ${precision} has incompatible time fields`)
	}
	let date = timezoneDate(parts, getTemporal())
	if (
		typeof value !== 'string' &&
		precision !== 'date' &&
		value.epochNanoseconds !== date.epochNanoseconds
	)
		throw new RangeError('YDB timezone text does not preserve the supplied instant')
	let microseconds = date.epochNanoseconds / 1000n
	let min = extended ? -4_611_669_897_600_000_000n : 0n
	let max = extended ? 4_611_669_811_199_999_999n : 4_291_747_199_999_999n
	if (microseconds < min || microseconds > max)
		throw new RangeError(`Timezone ${precision} is outside the YDB range`)
	return text.slice(0, text.lastIndexOf(',') + 1) + date.timeZoneId
}
