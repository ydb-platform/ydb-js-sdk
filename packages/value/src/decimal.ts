import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'

export class DecimalType implements Type {
	readonly kind = TypeKind.DECIMAL

	constructor(
		readonly precision: number,
		readonly scale: number
	) {
		if (
			!Number.isInteger(precision) ||
			precision < 1 ||
			precision > 35 ||
			!Number.isInteger(scale) ||
			scale < 0 ||
			scale > precision
		) {
			throw new TypeError('Decimal requires precision 1..35 and scale 0..precision')
		}
	}

	encode(): Ydb.Type {
		return create(Ydb.TypeSchema, {
			type: { case: 'decimalType', value: { precision: this.precision, scale: this.scale } },
		})
	}
}

let infinity = 10n ** 35n

function parseDecimal(text: string, scale: number, limit: bigint): bigint {
	let index = text[0] === '-' || text[0] === '+' ? 1 : 0
	let negative = text[0] === '-'
	if (text.length - index === 3) {
		let special = text.slice(index).toLowerCase()
		if (special === 'inf') return negative ? -infinity : infinity
		if (special === 'nan') return infinity + 1n
	}
	let magnitude = 0n
	let fractional = false
	let fractionDigits = 0
	let hasDigit = false
	for (; index < text.length; index++) {
		let char = text.charCodeAt(index)
		if (char === 46 && !fractional) {
			fractional = true
			continue
		}
		if (char < 48 || char > 57)
			throw new TypeError('Decimal requires decimal text without an exponent')
		hasDigit = true
		if (fractional && fractionDigits === scale) {
			if (char !== 48)
				throw new RangeError('Decimal value would require rounding to its scale')
			continue
		}
		magnitude = magnitude * 10n + BigInt(char - 48)
		if (magnitude >= limit) throw new RangeError('Decimal value exceeds its precision')
		if (fractional) fractionDigits++
	}
	if (!hasDigit) throw new TypeError('Decimal requires at least one digit')
	magnitude *= 10n ** BigInt(scale - fractionDigits)
	if (magnitude >= limit) throw new RangeError('Decimal value exceeds its precision')
	return negative ? -magnitude : magnitude
}

export class Decimal implements Value<DecimalType> {
	readonly value: bigint

	constructor(
		value: bigint | string,
		readonly type: DecimalType
	) {
		if (typeof value !== 'string' && typeof value !== 'bigint')
			throw new TypeError('Decimal requires exact decimal text or a scaled bigint')
		let limit = 10n ** BigInt(type.precision)
		this.value = typeof value === 'string' ? parseDecimal(value, type.scale, limit) : value
		let magnitude = this.value < 0n ? -this.value : this.value
		if (
			magnitude >= limit &&
			this.value !== infinity &&
			this.value !== -infinity &&
			this.value !== infinity + 1n
		) {
			throw new RangeError('Decimal value exceeds its precision')
		}
	}

	encode(): Ydb.Value {
		return create(Ydb.ValueSchema, {
			value: { case: 'low128', value: BigInt.asUintN(64, this.value) },
			high128: BigInt.asUintN(64, this.value >> 64n),
		})
	}

	toString(): string {
		if (this.value === infinity) return 'inf'
		if (this.value === -infinity) return '-inf'
		if (this.value === infinity + 1n) return 'nan'
		let digits = (this.value < 0n ? -this.value : this.value)
			.toString()
			.padStart(this.type.scale + 1, '0')
		if (this.type.scale) {
			let point = digits.length - this.type.scale
			let end = digits.length
			while (end > point && digits[end - 1] === '0') end--
			digits =
				end === point
					? digits.slice(0, point)
					: `${digits.slice(0, point)}.${digits.slice(point, end)}`
		}
		return this.value < 0n ? `-${digits}` : digits
	}
}
