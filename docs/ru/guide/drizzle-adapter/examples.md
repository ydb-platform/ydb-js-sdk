---
title: Drizzle Adapter — Примеры
---

# Примеры

В репозитории есть два runnable-примера:

- `examples/drizzle-adapter`: компактный TypeScript CLI-пример в стиле остальных SDK examples.
- `examples/drizzle-adapter-lab`: расширенная интерактивная TypeScript-лаборатория с UI, generated YQL, результатами и trace последних запросов.

```bash
cd examples/drizzle-adapter
npm install
npm start
```

```bash
cd examples/drizzle-adapter-lab
npm install
npm run db:up
npm start
```

Для lab откройте `http://localhost:3000`.

## Общая подготовка

Большинство примеров ниже предполагают такой объект `db` и схему.

```ts
import { asc, desc, eq, sql } from 'drizzle-orm'
import {
  createDrizzle,
  index,
  integer,
  many,
  one,
  relations,
  text,
  timestamp,
  ydbTable,
} from '@ydbjs/drizzle-adapter'

export const users = ydbTable('example_users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull().unique('example_users_email_unique'),
  name: text('name').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

export const projects = ydbTable(
  'example_projects',
  {
    id: integer('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [index('example_projects_owner_idx').on(table.ownerId).global().sync()]
)

export const tasks = ydbTable(
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

export const taskSnapshots = ydbTable('example_task_snapshots', {
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

export const usersRelations = relations(users, ({ many }) => ({
  ownedProjects: many(projects),
  assignedTasks: many(tasks),
}))

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(users, { fields: [projects.ownerId], references: [users.id] }),
  tasks: many(tasks),
}))

export const tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  assignee: one(users, { fields: [tasks.assigneeId], references: [users.id] }),
}))

export const db = createDrizzle({
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
const now = new Date()

const inserted = await db
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
const preparedUser = db
  .select({ id: users.id, email: users.email, name: users.name })
  .from(users)
  .where(eq(users.id, 1))
  .prepare('get_user_by_id')

const row = await preparedUser.get()
const rows = await preparedUser.all()
const values = await preparedUser.values()
```

Построители также можно передавать в методы выполнения на `db`.

```ts
const firstTask = await db.get(
  db.select({ id: tasks.id, title: tasks.title }).from(tasks).orderBy(asc(tasks.id)).limit(1)
)
```

## Raw execution

```ts
const allRows = await db.all(sql`SELECT id, email FROM ${users} ORDER BY id`)
const oneRow = await db.get(sql`SELECT id, title FROM ${tasks} WHERE id = ${3001} LIMIT 1`)
const rawValues = await db.values<[number, string]>(sql`SELECT id, name FROM ${users} ORDER BY id`)
await db.execute(sql`DELETE FROM ${tasks} WHERE status = ${'archived'}`)
```

## Relations

```ts
const result = await db.query.projects.findMany({
  columns: { id: true, title: true, status: true },
  orderBy: (project, { asc }) => [asc(project.id)],
  with: {
    owner: { columns: { id: true, email: true, name: true } },
    tasks: {
      columns: { id: true, title: true, status: true, priority: true },
      orderBy: (task, { desc }) => [desc(task.estimateHours)],
      with: {
        assignee: { columns: { id: true, name: true } },
      },
    },
  },
})
```

## Joins, CTE и set operators

```ts
const joinedRows = await db
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

const usersWithProjects = await db
  .select({ id: users.id, name: users.name })
  .from(users)
  .leftSemiJoin(projects, eq(projects.ownerId, users.id))
  .execute()

const backlog = db
  .$with('backlog')
  .as(
    db
      .select({ projectId: tasks.projectId, taskId: tasks.id, title: tasks.title })
      .from(tasks)
      .where(eq(tasks.status, 'todo'))
  )

const backlogRows = await db.with(backlog).select().from(backlog).execute()

const projectOwners = db.selectDistinct({ userId: projects.ownerId }).from(projects)
const taskAssignees = db.selectDistinct({ userId: tasks.assigneeId }).from(tasks)

const activePeople = await projectOwners.union(taskAssignees).execute()
const ownerAndAssignee = await projectOwners.intersect(taskAssignees).execute()
const ownersWithoutTasks = await projectOwners.except(taskAssignees).execute()
```

## Distinct, grouping и windows

```ts
const statuses = await db
  .selectDistinct({ status: tasks.status })
  .from(tasks)
  .orderBy(asc(tasks.status))
  .execute()

const newestProjectPerOwner = await db
  .selectDistinctOn([projects.ownerId], {
    ownerId: projects.ownerId,
    projectId: projects.id,
    title: projects.title,
    updatedAt: projects.updatedAt,
  })
  .from(projects)
  .orderBy(asc(projects.ownerId), desc(projects.updatedAt))
  .execute()

const totals = await db
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
import { asTable, values, valuesTable } from '@ydbjs/drizzle-adapter'

const lanes = await db
  .select({ lane: sql<string>`lanes.lane`, weight: sql<number>`lanes.weight` })
  .fromValues(
    [
      { lane: 'backlog', weight: 1 },
      { lane: 'review', weight: 2 },
    ],
    { alias: 'lanes', columns: ['lane', 'weight'] }
  )
  .execute()

const priorityMap = valuesTable(
  [
    { priority: 'high', band: 'P1' },
    { priority: 'medium', band: 'P2' },
  ],
  { alias: 'priority_map', columns: ['priority', 'band'] }
)

const mappedTasks = await db
  .select({ taskId: tasks.id, band: sql<string>`priority_map.band` })
  .from(tasks)
  .innerJoin(priorityMap, eq(tasks.priority, sql`priority_map.priority`))
  .execute()

const source = values([{ id: 1, name: 'Ada' }])
const valuesPreview = db
  .select({ id: sql`v.id`, name: sql`v.name` })
  .from(sql`${source} AS v`)
  .toSQL()
const asTablePreview = db
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
    const newTask = {
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
  const newTask = {
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
import {
  buildAddColumnsSql,
  buildAddIndexSql,
  buildAlterTableSetOptionsSql,
  buildCreateTableSql,
  buildDropTableSql,
  buildMigrationSql,
  buildRenameTableSql,
  migrate,
} from '@ydbjs/drizzle-adapter'

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

const createSql = buildCreateTableSql(tasks, { ifNotExists: true })
const dropSql = buildDropTableSql(tasks, { ifExists: true })
const migrationSql = buildMigrationSql([{ kind: 'create_table', table: tasks, ifNotExists: true }])
const renameSql = buildRenameTableSql(tasks, 'example_tasks_archive')
const alterSql = buildAlterTableSetOptionsSql(tasks, { auto_partitioning_by_size: true })

const tasksExpanded = ydbTable('example_tasks', {
  id: integer('id').primaryKey(),
  stage: text('stage').notNull(),
})
const tasksStatusIndex = index('example_tasks_status_idx').on(tasks.status).build(tasks)

const addColumnsSql = buildAddColumnsSql(tasksExpanded, [tasksExpanded.stage])
const addIndexSql = buildAddIndexSql(tasks, tasksStatusIndex)
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
} from '@ydbjs/drizzle-adapter'

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
