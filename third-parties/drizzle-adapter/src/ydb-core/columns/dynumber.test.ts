import { expect, test } from 'vitest'
import { Type_PrimitiveTypeId } from '@ydbjs/api/value'
import { Primitive, PrimitiveType } from '@ydbjs/value/primitive'
import { dyNumber, ydbTable } from '../../schema.ts'

test('DyNumber columns preserve text from SDK values and native strings', () => {
	let table = ydbTable('dynumber_codec', { value: dyNumber() })
	let text = '123456789012345678901234567890.12345678'
	let value = new Primitive(
		{ value: { case: 'textValue', value: text } },
		new PrimitiveType(Type_PrimitiveTypeId.DYNUMBER)
	)

	expect(table.value.mapFromDriverValue(value)).toBe(text)
	expect(table.value.mapFromDriverValue(text)).toBe(text)
})
