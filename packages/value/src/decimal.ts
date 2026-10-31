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

export class Decimal implements Value<DecimalType> {
	constructor(
		readonly value: bigint,
		readonly type: DecimalType
	) {
		let magnitude = value < 0n ? -value : value
		if (
			magnitude >= 10n ** BigInt(type.precision) &&
			value !== 10n ** 35n &&
			value !== -(10n ** 35n) &&
			value !== 10n ** 35n + 1n
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
		if (this.value === 10n ** 35n) return 'inf'
		if (this.value === -(10n ** 35n)) return '-inf'
		if (this.value === 10n ** 35n + 1n) return 'nan'
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
