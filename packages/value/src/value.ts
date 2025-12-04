import * as Ydb from '@ydbjs/api/value'

import type { Type } from './type.js'

export interface Value<T extends Type = Type> {
	type: T
	high128?: bigint
	encode(): Ydb.Value
}
