import { expect, test } from 'vitest'

import * as migrator from './migrator.ts'

let expectedMigratorExports = [
	'buildAddChangefeedSql',
	'buildAddColumnFamilySql',
	'buildAddColumnsSql',
	'buildAddIndexSql',
	'buildAlterAsyncReplicationSql',
	'buildAlterColumnFamilySql',
	'buildAlterColumnSetFamilySql',
	'buildAlterGroupSql',
	'buildAlterTableResetOptionsSql',
	'buildAlterTableSetOptionsSql',
	'buildAlterTableSql',
	'buildAlterTopicSql',
	'buildAlterTransferSql',
	'buildAlterUserSql',
	'buildAnalyzeSql',
	'buildCreateAsyncReplicationSql',
	'buildCreateGroupSql',
	'buildCreateSecretSql',
	'buildCreateTableSql',
	'buildCreateTopicSql',
	'buildCreateTransferSql',
	'buildCreateUserSql',
	'buildCreateViewSql',
	'buildDropAsyncReplicationSql',
	'buildDropChangefeedSql',
	'buildDropColumnsSql',
	'buildDropGroupSql',
	'buildDropIndexSql',
	'buildDropTableSql',
	'buildDropTopicSql',
	'buildDropTransferSql',
	'buildDropUserSql',
	'buildDropViewSql',
	'buildGrantSql',
	'buildMigrationLockTableBootstrapSql',
	'buildMigrationSql',
	'buildRenameTableSql',
	'buildRevokeSql',
	'buildShowCreateSql',
	'migrate',
] as const

test('migrator entrypoint exposes exactly the migration surface', () => {
	expect(Object.keys(migrator).sort()).toEqual([...expectedMigratorExports])
})
