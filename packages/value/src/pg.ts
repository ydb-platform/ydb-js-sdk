import { isUint8Array } from 'node:util/types'
import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'

export interface PgTypeOptions {
	typeName?: string | undefined
	typeModifier?: string | undefined
	oid?: number | undefined
	typlen?: number | undefined
	typmod?: number | undefined
}

export class PgType implements Type {
	readonly typeName: string
	readonly typeModifier: string
	readonly oid: number
	readonly typlen: number
	readonly typmod: number
	#typeInstance?: Ydb.Type

	constructor(typeNameOrOptions: string | PgTypeOptions) {
		let options: PgTypeOptions
		if (typeof typeNameOrOptions === 'string') {
			let name = typeNameOrOptions.toLowerCase()
			let array = name.startsWith('_')
			let base = array ? name.slice(1) : name
			if (!base) throw new TypeError('Pg type requires a name or a nonzero OID')
			options = {
				typeName: `${array ? '_' : ''}${base.startsWith('pg') && !base.startsWith('pg_') ? base : `pg${base}`}`,
			}
		} else {
			if (
				!typeNameOrOptions ||
				typeof typeNameOrOptions !== 'object' ||
				Array.isArray(typeNameOrOptions)
			) {
				throw new TypeError('Pg type requires a name or descriptor')
			}
			options = typeNameOrOptions
		}
		this.typeName = options.typeName ?? ''
		this.typeModifier = options.typeModifier ?? ''
		this.oid = options.oid ?? 0
		this.typlen = options.typlen ?? 0
		this.typmod = options.typmod ?? 0
		if (typeof this.typeName !== 'string' || typeof this.typeModifier !== 'string') {
			throw new TypeError('Pg type name and modifier must be strings')
		}
		if (!Number.isInteger(this.oid) || this.oid < 0 || this.oid > 0xffffffff) {
			throw new RangeError('Pg OID must be an unsigned 32-bit integer')
		}
		if (!this.typeName && this.oid === 0) {
			throw new TypeError('Pg type requires a name or a nonzero OID')
		}
		for (let [name, value] of [
			['typlen', this.typlen],
			['typmod', this.typmod],
		] as const) {
			if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
				throw new RangeError(`Pg ${name} must be a signed 32-bit integer`)
			}
		}
	}

	get kind(): TypeKind.PG_TYPE {
		return TypeKind.PG_TYPE
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, {
				type: {
					case: 'pgType',
					value: {
						typeName: this.typeName,
						typeModifier: this.typeModifier,
						oid: this.oid,
						typlen: this.typlen,
						typmod: this.typmod,
					},
				},
			})
		}
		return this.#typeInstance
	}
}

export class Pg implements Value<PgType> {
	readonly type: PgType
	readonly value: string | Uint8Array | null
	#valueInstance?: Ydb.Value

	constructor(value: string | Uint8Array | null, type: PgType) {
		if (!(type instanceof PgType)) throw new TypeError('Pg value requires a PgType')
		if (value !== null && typeof value !== 'string' && !isUint8Array(value)) {
			throw new TypeError('Pg value must be text, binary bytes, or null')
		}
		this.type = type
		this.value = value
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			this.#valueInstance = create(Ydb.ValueSchema, {
				value:
					this.value === null
						? { case: 'nullFlagValue', value: 0 }
						: typeof this.value === 'string'
							? { case: 'textValue', value: this.value }
							: { case: 'bytesValue', value: this.value },
			})
		}
		return this.#valueInstance
	}
}
