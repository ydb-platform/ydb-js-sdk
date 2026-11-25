---
title: Drizzle Adapter — Примеры
---

# Примеры

В репозитории есть runnable-пример:

- `examples/drizzle-adapter`: компактный TypeScript CLI-пример в стиле остальных SDK examples.

```bash
cd examples/drizzle-adapter
npm install
npm start
```

## Общая подготовка

Большинство примеров ниже предполагают такой объект `db` и схему.

```ts
import { createDrizzle, many, one, relations } from '@ydbjs/drizzle-adapter'
import { index, integer, text, timestamp, ydbTable } from '@ydbjs/drizzle-adapter/schema'
import { asc, desc, eq, sql } from 'drizzle-orm'

export let users = ydbTable('example_users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull().unique('example_users_email_unique'),
  name: text('name').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

export let projects = ydbTable(
  'example_projects',
  {
    id: integer('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => {
    return [index('example_projects_owner_idx').on(table.ownerId).global().sync()]
  }
)

export let tasks = ydbTable(
  'example_tasks',
  {
    id: integer('id').primaryKey(),
    projectId: integer('project_id').notNull(),
    assigneeId: integer('assignee_id').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    priority: text('priority').notNull(),
    estimateHours: integer('estimate_hours').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [
    index('example_tasks_project_idx').on(table.projectId).global().sync(),
    index('example_tasks_assignee_idx').on(table.assigneeId).global().sync(),
  ]
)

export let taskSnapshots = ydbTable('example_task_snapshots', {
  id: integer('id').primaryKey(),
  projectId: integer('project_id').notNull(),
  assigneeId: integer('assignee_id').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  priority: text('priority').notNull(),
  estimateHours: integer('estimate_hours').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

export let usersRelations = relations(users, ({ many }) => ({
  ownedProjects: many(projects),
  assignedTasks: many(tasks),
}))

export let projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(users, { fields: [projects.ownerId], references: [users.id] }),
  tasks: many(tasks),
}))

export let tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  assignee: one(users, { fields: [tasks.assigneeId], references: [users.id] }),
}))

export let db = createDrizzle({
  connectionString: process.env.YDB_CONNECTION_STRING!,
  schema: {
    users,
    projects,
    tasks,
    taskSnapshots,
    usersRelations,
    projectsRelations,
    tasksRelations,
  },
})
```

## CRUD и returning

```ts
let now = new Date()

let inserted = await db
  .insert(users)
  .values({
    id: 1,
    email: 'ada@example.com',
    name: 'Ada',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  .returning({ id: users.id, email: users.email })
  .execute()

await db
  .insert(users)
  .values({
    id: 1,
    email: 'ada@new.example.com',
    name: 'Ada',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  .onDuplicateKeyUpdate({ set: { email: 'ada@new.example.com', updatedAt: now } })
  .execute()

await db
  .upsert(users)
  .values({
    id: 2,
    email: 'grace@example.com',
    name: 'Grace',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  .execute()
await db
  .replace(users)
  .values({
    id: 2,
    email: 'grace@example.com',
    name: 'Grace Hopper',
    status: 'review',
    createdAt: now,
    updatedAt: now,
  })
  .execute()

await db.update(users).set({ status: 'paused', updatedAt: now }).where(eq(users.id, 2)).execute()
await db
  .delete(users)
  .where(eq(users.id, 2))
  .returning({ id: users.id, email: users.email })
  .execute()
```

## Batch-мутации

```ts
await db
  .batchUpdate(tasks)
  .set({ status: 'review', updatedAt: new Date() })
  .where(eq(tasks.status, 'blocked'))
  .execute()

await db.batchDelete(tasks).where(eq(tasks.status, 'done')).execute()
```

## Prepared reads

```ts
let preparedUser = db
  .select({ id: users.id, email: users.email, name: users.name })
  .from(users)
  .where(eq(users.id, 1))
  .prepare()

let row = await preparedUser.get()
let rows = await preparedUser.all()
let values = await preparedUser.values()
```

Построители также можно передавать в методы выполнения на `db`.

```ts
let firstTask = await db.get(
  db.select({ id: tasks.id, title: tasks.title }).from(tasks).orderBy(asc(tasks.id)).limit(1)
)
```

## Raw execution

```ts
let allRows = await db.all(sql`SELECT id, email FROM ${users} ORDER BY id`)
let oneRow = await db.get(sql`SELECT id, title FROM ${tasks} WHERE id = ${3001} LIMIT 1`)
let rawValues = await db.values<[number, string]>(sql`SELECT id, name FROM ${users} ORDER BY id`)
await db.execute(sql`DELETE FROM ${tasks} WHERE status = ${'archived'}`)
```

## Relations

```ts
let result = await db.query.projects.findMany({
  columns: { id: true, title: true, status: true },
  orderBy: (project, { asc }) => {
    return [asc(project.id)]
  },
  with: {
    owner: { columns: { id: true, email: true, name: true } },
    tasks: {
      columns: { id: true, title: true, status: true, priority: true },
      orderBy: (task, { desc }) => {
        return [desc(task.estimateHours)]
      },
      with: {
        assignee: { columns: { id: true, name: true } },
      },
    },
  },
})
```

## Joins, CTE и set operators

```ts
let joinedRows = await db
  .select({
    projectId: projects.id,
    projectTitle: projects.title,
    ownerName: users.name,
    taskTitle: tasks.title,
  })
  .from(projects)
  .innerJoin(users, eq(projects.ownerId, users.id))
  .leftJoin(tasks, eq(tasks.projectId, projects.id))
  .orderBy(asc(projects.id), asc(tasks.id))
  .execute()

let usersWithProjects = await db
  .select({ id: users.id, name: users.name })
  .from(users)
  .leftSemiJoin(projects, eq(projects.ownerId, users.id))
  .execute()

let backlog = db
  .$with('backlog')
  .as(
    db
      .select({ projectId: tasks.projectId, taskId: tasks.id, title: tasks.title })
      .from(tasks)
      .where(eq(tasks.status, 'todo'))
  )

let backlogRows = await db.with(backlog).select().from(backlog).execute()

let projectOwners = db.selectDistinct({ userId: projects.ownerId }).from(projects)
let taskAssignees = db.selectDistinct({ userId: tasks.assigneeId }).from(tasks)

let activePeople = await projectOwners.union(taskAssignees).execute()
let ownerAndAssignee = await projectOwners.intersect(taskAssignees).execute()
let ownersWithoutTasks = await projectOwners.except(taskAssignees).execute()
```

## Distinct, grouping и windows

```ts
let statuses = await db
  .selectDistinct({ status: tasks.status })
  .from(tasks)
  .orderBy(asc(tasks.status))
  .execute()

let newestProjectPerOwner = await db
  .selectDistinctOn([projects.ownerId], {
    ownerId: projects.ownerId,
    projectId: projects.id,
    title: projects.title,
    updatedAt: projects.updatedAt,
  })
  .from(projects)
  .orderBy(asc(projects.ownerId), desc(projects.updatedAt))
  .execute()

let totals = await db
  .select({
    status: tasks.status,
    total: sql<number>`count(*)`,
    totalEstimate: sql<number>`sum(${tasks.estimateHours})`,
  })
  .from(tasks)
  .groupCompactBy(tasks.status)
  .assumeOrderBy(tasks.status)
  .orderBy(asc(tasks.status))
  .execute()
```

## Inline sources

```ts
import { asTable, values, valuesTable } from '@ydbjs/drizzle-adapter/sql'

let lanes = await db
  .select({ lane: sql<string>`lanes.lane`, weight: sql<number>`lanes.weight` })
  .fromValues(
    [
      { lane: 'backlog', weight: 1 },
      { lane: 'review', weight: 2 },
    ],
    { alias: 'lanes', columns: ['lane', 'weight'] }
  )
  .execute()

let priorityMap = valuesTable(
  [
    { priority: 'high', band: 'P1' },
    { priority: 'medium', band: 'P2' },
  ],
  { alias: 'priority_map', columns: ['priority', 'band'] }
)

let mappedTasks = await db
  .select({ taskId: tasks.id, band: sql<string>`priority_map.band` })
  .from(tasks)
  .innerJoin(priorityMap, eq(tasks.priority, sql`priority_map.priority`))
  .execute()

let source = values([{ id: 1, name: 'Ada' }])
let valuesPreview = db
  .select({ id: sql`v.id`, name: sql`v.name` })
  .from(sql`${source} AS v`)
  .toSQL()
let asTablePreview = db
  .select({ id: sql`r.id`, name: sql`r.name` })
  .from(asTable('$rows', 'r'))
  .toSQL()
```

## Insert from select

```ts
await db
  .insert(taskSnapshots)
  .select(
    db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        assigneeId: tasks.assigneeId,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        estimateHours: tasks.estimateHours,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(eq(tasks.status, 'blocked'))
  )
  .execute()
```

## Транзакции

```ts
await db.transaction(
  async (tx) => {
    let newTask = {
      id: 100,
      projectId: 10,
      assigneeId: 1,
      title: 'Transactional task',
      status: 'todo',
      priority: 'high',
      estimateHours: 4,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    await tx.insert(tasks).values(newTask).execute()
    return tx
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(eq(tasks.id, newTask.id))
      .prepare()
      .get()
  },
  {
    accessMode: 'read write',
    isolationLevel: 'serializableReadWrite',
    idempotent: true,
  }
)

await db.transaction(async (tx) => {
  let newTask = {
    id: 101,
    projectId: 10,
    assigneeId: 1,
    title: 'Rolled back task',
    status: 'todo',
    priority: 'medium',
    estimateHours: 2,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  await tx.insert(tasks).values(newTask).execute()
  tx.rollback()
})
```

## DDL builders и миграции

```ts
import { index, integer, text, ydbTable } from '@ydbjs/drizzle-adapter/schema'
import {
  buildAddColumnsSql,
  buildAddIndexSql,
  buildAlterTableSetOptionsSql,
  buildCreateTableSql,
  buildDropTableSql,
  buildMigrationSql,
  buildRenameTableSql,
  migrate,
} from '@ydbjs/drizzle-adapter/migrator'

await migrate(db, {
  migrationsTable: '__example_migrations',
  migrationLock: true,
  migrations: [
    {
      name: '001_create_tables',
      operations: [
        { kind: 'create_table', table: users, ifNotExists: true },
        { kind: 'create_table', table: projects, ifNotExists: true },
        { kind: 'create_table', table: tasks, ifNotExists: true },
      ],
    },
  ],
})

let createSql = buildCreateTableSql(tasks, { ifNotExists: true })
let dropSql = buildDropTableSql(tasks, { ifExists: true })
let migrationSql = buildMigrationSql([{ kind: 'create_table', table: tasks, ifNotExists: true }])
let renameSql = buildRenameTableSql(tasks, 'example_tasks_archive')
let alterSql = buildAlterTableSetOptionsSql(tasks, { auto_partitioning_by_size: true })

let tasksExpanded = ydbTable('example_tasks', {
  id: integer('id').primaryKey(),
  stage: text('stage').notNull(),
})
let tasksStatusIndex = index('example_tasks_status_idx').on(tasks.status).build(tasks)

let addColumnsSql = buildAddColumnsSql(tasksExpanded, [tasksExpanded.stage])
let addIndexSql = buildAddIndexSql(tasks, tasksStatusIndex)
```

## YQL scripts

```ts
import {
  commit,
  declareParam,
  doBlock,
  intoResult,
  pragma,
  yqlScript,
} from '@ydbjs/drizzle-adapter/sql'
import { sql } from 'drizzle-orm'

await db.execute(
  yqlScript(
    pragma('TablePathPrefix', '/local'),
    declareParam('$taskId', 'Int32'),
    doBlock([
      intoResult(sql`SELECT id, title FROM ${tasks} WHERE id = $taskId`, 'picked_task'),
      commit(),
    ])
  )
)
```
