import { SQL, type SQLWrapper, sql as yql } from 'drizzle-orm/sql/sql'

export type YdbScriptPrimitive = string | number | boolean | bigint | null | Date | Uint8Array

export type YdbScriptExpression = YdbScriptPrimitive | SQLWrapper | { kind: 'default' }

export interface YdbActionParameter {
	name: string
	optional?: boolean
}

function assertPragmaName(name: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(name)) {
		throw new Error('YDB PRAGMA name must be a dotted identifier')
	}
}

function renderNamedExpression(name: string, context: string): string {
	const rendered = name.startsWith('$') ? name : `$${name}`
	if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(rendered)) {
		throw new Error(`YDB ${context} must look like $name`)
	}

	return rendered
}

function renderIdentifier(name: string, context: string): SQL {
	if (!name) {
		throw new Error(`YDB ${context} must not be empty`)
	}

	return yql`${yql.identifier(name)}`
}

function escapeDoubleQuoted(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function renderExpression(value: YdbScriptExpression): SQL {
	if (
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		value.kind === 'default'
	) {
		return yql.raw('default')
	}

	if (value === null) {
		return yql.raw('NULL')
	}

	if (value instanceof Date) {
		return yql.raw(escapeDoubleQuoted(value.toISOString()))
	}

	if (value instanceof Uint8Array) {
		return yql`${value}`
	}

	if (typeof value === 'string') {
		return yql.raw(escapeDoubleQuoted(value))
	}

	if (typeof value === 'number' || typeof value === 'bigint') {
		return yql.raw(String(value))
	}

	if (typeof value === 'boolean') {
		return yql.raw(value ? 'TRUE' : 'FALSE')
	}

	return yql`${value}`
}

function renderStatement(statement: string | SQLWrapper): SQL {
	return typeof statement === 'string' ? yql.raw(statement) : yql`${statement}`
}

function renderStatements(statements: readonly (string | SQLWrapper)[]): SQL {
	return yql.join(
		statements.map((statement) => renderStatement(statement)),
		yql.raw('\n')
	)
}

export function yqlScript(...statements: (string | SQLWrapper)[]): SQL {
	if (statements.length === 0) {
		throw new Error('YDB yqlScript() requires at least one statement')
	}

	return renderStatements(statements)
}

export function pragma(
	name: string,
	value?: YdbScriptExpression | readonly YdbScriptExpression[]
): SQL {
	assertPragmaName(name)

	if (value === undefined) {
		return yql.raw(`PRAGMA ${name};`)
	}

	if (Array.isArray(value)) {
		const values = value as readonly YdbScriptExpression[]
		return yql`PRAGMA ${yql.raw(name)}(${yql.join(
			values.map((item) => renderExpression(item)),
			yql`, `
		)});`
	}

	return yql`PRAGMA ${yql.raw(name)} = ${renderExpression(value as YdbScriptExpression)};`
}

export function kMeansTreeSearchTopSize(value: number | string): SQL {
	return pragma('ydb.KMeansTreeSearchTopSize', String(value))
}

export function declareParam(name: string, dataType: string): SQL {
	const parameterName = renderNamedExpression(name, 'DECLARE parameter')
	if (!dataType.trim()) {
		throw new Error('YDB DECLARE data type must not be empty')
	}

	return yql.raw(`DECLARE ${parameterName} AS ${dataType};`)
}

export function commit(): SQL {
	return yql.raw('COMMIT;')
}

export function defineAction(
	name: string,
	parameters: readonly (string | YdbActionParameter)[],
	statements: readonly (string | SQLWrapper)[]
): SQL {
	const actionName = renderNamedExpression(name, 'ACTION name')
	const renderedParameters = parameters.map((parameter) => {
		const config = typeof parameter === 'string' ? { name: parameter } : parameter
		const parameterName = renderNamedExpression(config.name, 'ACTION parameter')
		return `${parameterName}${config.optional ? '?' : ''}`
	})

	if (statements.length === 0) {
		throw new Error('YDB DEFINE ACTION requires at least one statement')
	}

	return yql`DEFINE ACTION ${yql.raw(actionName)}(${yql.raw(renderedParameters.join(', '))}) AS
${renderStatements(statements)}
END DEFINE;`
}

export function doAction(name: string, args: readonly YdbScriptExpression[] = []): SQL {
	if (name !== 'EMPTY_ACTION') {
		renderNamedExpression(name, 'DO action name')
	}

	const actionName =
		name === 'EMPTY_ACTION' ? name : renderNamedExpression(name, 'DO action name')
	return yql`DO ${yql.raw(actionName)}(${yql.join(
		args.map((arg) => renderExpression(arg)),
		yql`, `
	)});`
}

export function doBlock(statements: readonly (string | SQLWrapper)[]): SQL {
	if (statements.length === 0) {
		throw new Error('YDB DO BEGIN block requires at least one statement')
	}

	return yql`DO BEGIN
${renderStatements(statements)}
END DO;`
}

export function intoResult(query: SQLWrapper | string, resultName: string): SQL {
	return yql`${renderStatement(query)} INTO RESULT ${renderIdentifier(resultName, 'INTO RESULT name')};`
}
