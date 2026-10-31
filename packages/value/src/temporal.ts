import { TZDate } from '@date-fns/tz'

export type TimezonePrecision = 'date' | 'datetime' | 'timestamp'

function timezoneParts(text: string) {
	let parts = text.match(
		/^([+-]?\d{1,6})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,6}))?)?,([^,]+)$/
	)
	if (!parts) throw new TypeError('Expected a YDB timezone date followed by an IANA timezone')
	let [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = parts
	let year = Number(yearText)
	if (year === 0) throw new RangeError('YDB dates have no year zero')
	// YDB uses historical years; JavaScript uses astronomical years including zero.
	if (year < 0) year++
	let month = Number(monthText) - 1
	let day = Number(dayText)
	let hour = Number(hourText ?? 0)
	let minute = Number(minuteText ?? 0)
	let second = Number(secondText ?? 0)
	let milliseconds = Number((fraction ?? '').padEnd(3, '0').slice(0, 3))
	let calendar = new Date(0)
	calendar.setUTCFullYear(year, month, day)
	calendar.setUTCHours(hour, minute, second, milliseconds)
	if (
		!Number.isFinite(calendar.getTime()) ||
		calendar.getUTCFullYear() !== year ||
		calendar.getUTCMonth() !== month ||
		calendar.getUTCDate() !== day ||
		calendar.getUTCHours() !== hour ||
		calendar.getUTCMinutes() !== minute ||
		calendar.getUTCSeconds() !== second
	) {
		throw new RangeError('Invalid YDB timezone date fields')
	}
	return {
		year,
		month,
		day,
		hour,
		minute,
		second,
		milliseconds,
		fraction,
		zone: zone!,
		hasTime: hourText !== undefined,
	}
}

function timezoneDate(parts: ReturnType<typeof timezoneParts>): TZDate {
	let { year, month, day, hour, minute, second, milliseconds, zone } = parts
	// A leap-year seed avoids the native Date constructor's 1900 adjustment for years 0..99.
	let date = TZDate.tz(
		zone,
		year >= 0 && year < 100 ? 400 : year,
		month,
		day,
		hour,
		minute,
		second,
		milliseconds
	)
	if (year >= 0 && year < 100) date.setFullYear(year)
	if (!Number.isFinite(date.getTime()))
		throw new RangeError('Invalid YDB timezone date or timezone')
	return date
}

export function parseTimezoneDate(text: string): TZDate {
	return timezoneDate(timezoneParts(text))
}

export function timezoneText(
	value: TZDate | string,
	precision: TimezonePrecision,
	extended: boolean
): string {
	let text: string
	if (typeof value === 'string') {
		text = value
	} else {
		if (!Number.isFinite(value.getTime()) || !value.timeZone)
			throw new RangeError('A valid TZDate with an explicit timezone is required')
		let year = value.getFullYear()
		if (year <= 0) year--
		let date = `${year}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
		let time =
			precision === 'date'
				? ''
				: `T${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`
		let fraction =
			precision === 'timestamp'
				? `.${String(value.getMilliseconds()).padStart(3, '0')}000`
				: ''
		text = `${date}${time}${fraction},${value.timeZone}`
	}
	let parts = timezoneParts(text)
	if (
		(precision === 'date') === parts.hasTime ||
		(precision !== 'timestamp' && parts.fraction !== undefined)
	) {
		throw new TypeError(`Timezone ${precision} has incompatible time fields`)
	}
	let date = timezoneDate(parts)
	let seconds = Math.floor(date.getTime() / 1000)
	let min = extended ? -4_611_669_897_600 : 0
	let max = extended ? 4_611_669_811_199 : 4_291_747_199
	if (seconds < min || seconds > max)
		throw new RangeError(`Timezone ${precision} is outside the YDB range`)
	return text
}
