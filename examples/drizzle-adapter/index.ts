/**
 * YDB Drizzle Adapter Example
 *
 * A compact TypeScript CLI example that follows the same style as the other SDK examples.
 * For an interactive showcase, see examples/drizzle-adapter-lab.
 */

import { asc, eq, sql } from 'drizzle-orm'
import {
	createDrizzle,
	index,
	integer,
	migrate,
	relations,
	text,
	timestamp,
	ydbTable,
} from '@ydbjs/drizzle-adapter'

const connectionString = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'

const users = ydbTable(
	'drizzle_example_users',
	{
		id: integer('id').primaryKey(),
		email: text('email').notNull(),
		name: text('name').notNull(),
		status: text('status').notNull(),
		createdAt: timestamp('created_at').notNull(),
		updatedAt: timestamp('updated_at').notNull(),
	},
	(table) => [index('drizzle_example_users_status_idx').on(table.status).global().sync()]
)

const projects = ydbTable(
	'drizzle_example_projects',
	{
		id: integer('id').primaryKey(),
		ownerId: integer('owner_id').notNull(),
		title: text('title').notNull(),
		status: text('status').notNull(),
		createdAt: timestamp('created_at').notNull(),
		updatedAt: timestamp('updated_at').notNull(),
	},
	(table) => [index('drizzle_example_projects_owner_idx').on(table.ownerId).global().sync()]
)

const tasks = ydbTable(
	'drizzle_example_tasks',
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
		index('drizzle_example_tasks_project_idx').on(table.projectId).global().sync(),
		index('drizzle_example_tasks_assignee_idx').on(table.assigneeId).global().sync(),
	]
)

const usersRelations = relations(users, ({ many }) => ({
	ownedProjects: many(projects),
	assignedTasks: many(tasks),
}))

const projectsRelations = relations(projects, ({ one, many }) => ({
	owner: one(users, {
		fields: [projects.ownerId],
		references: [users.id],
	}),
	tasks: many(tasks),
}))

const tasksRelations = relations(tasks, ({ one }) => ({
	project: one(projects, {
		fields: [tasks.projectId],
		references: [projects.id],
	}),
	assignee: one(users, {
		fields: [tasks.assigneeId],
		references: [users.id],
	}),
}))

const schema = {
	users,
	projects,
	tasks,
	usersRelations,
	projectsRelations,
	tasksRelations,
}

const db = createDrizzle({
	connectionString,
	schema,
})

async function bootstrapSchema() {
	await migrate(db, {
		migrationsTable: '__drizzle_example_migrations',
		migrationLock: {
			table: '__drizzle_example_migrations_lock',
			key: 'drizzle_example',
			leaseMs: 60_000,
			acquireTimeoutMs: 10_000,
			retryIntervalMs: 300,
		},
		migrations: [
			{
				name: '001_create_drizzle_example_tables',
				operations: [
					{ kind: 'create_table', table: users, ifNotExists: true },
					{ kind: 'create_table', table: projects, ifNotExists: true },
					{ kind: 'create_table', table: tasks, ifNotExists: true },
				],
			},
		],
	})
}

async function resetData() {
	await db.delete(tasks).execute()
	await db.delete(projects).execute()
	await db.delete(users).execute()
}

async function seedData() {
	const now = new Date()

	await db.insert(users).values([
		{
			id: 1,
			email: 'ada@example.com',
			name: 'Ada Lovelace',
			status: 'active',
			createdAt: now,
			updatedAt: now,
		},
		{
			id: 2,
			email: 'grace@example.com',
			name: 'Grace Hopper',
			status: 'active',
			createdAt: now,
			updatedAt: now,
		},
	])

	await db.insert(projects).values({
		id: 10,
		ownerId: 1,
		title: 'Drizzle Adapter Demo',
		status: 'active',
		createdAt: now,
		updatedAt: now,
	})

	await db.insert(tasks).values([
		{
			id: 100,
			projectId: 10,
			assigneeId: 1,
			title: 'Define schema',
			status: 'done',
			priority: 'high',
			estimateHours: 4,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: 101,
			projectId: 10,
			assigneeId: 2,
			title: 'Run relation query',
			status: 'todo',
			priority: 'medium',
			estimateHours: 2,
			createdAt: now,
			updatedAt: now,
		},
	])
}

try {
	await db.$client.ready?.()
	await bootstrapSchema()
	await resetData()
	await seedData()

	await db
		.upsert(users)
		.values({
			id: 2,
			email: 'grace@example.com',
			name: 'Grace Hopper',
			status: 'review',
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.execute()

	await db.update(tasks).set({ status: 'review' }).where(eq(tasks.id, 101)).execute()

	const joinedRows = await db
		.select({
			projectTitle: projects.title,
			taskTitle: tasks.title,
			assigneeName: users.name,
			taskStatus: tasks.status,
		})
		.from(tasks)
		.innerJoin(projects, eq(tasks.projectId, projects.id))
		.innerJoin(users, eq(tasks.assigneeId, users.id))
		.orderBy(asc(tasks.id))
		.execute()

	const projectDashboard = await db.query.projects.findMany({
		columns: { id: true, title: true, status: true },
		where: (table, { eq }) => eq(table.status, 'active'),
		orderBy: (table, { asc }) => [asc(table.id)],
		with: {
			owner: {
				columns: { id: true, name: true, email: true },
			},
			tasks: {
				columns: { id: true, title: true, status: true, priority: true },
				orderBy: (table, { asc }) => [asc(table.id)],
				with: {
					assignee: {
						columns: { id: true, name: true },
					},
				},
			},
		},
	})

	const reviewTask = await db.query.tasks.findFirst({
		columns: {
			id: true,
			title: true,
			status: true,
			priority: true,
			estimateHours: true,
		},
		where: (table, { eq }) => eq(table.status, 'review'),
		orderBy: (table, { asc }) => [asc(table.id)],
		with: {
			project: {
				columns: { id: true, title: true, status: true },
				with: {
					owner: {
						columns: { id: true, name: true, email: true },
					},
				},
			},
			assignee: {
				columns: { id: true, name: true, status: true },
			},
		},
	})

	const userWorkloads = await db.query.users.findMany({
		columns: { id: true, name: true, email: true, status: true },
		orderBy: (table, { asc }) => [asc(table.id)],
		with: {
			ownedProjects: {
				columns: { id: true, title: true, status: true },
				orderBy: (table, { asc }) => [asc(table.id)],
				with: {
					tasks: {
						columns: {
							id: true,
							title: true,
							status: true,
							priority: true,
							estimateHours: true,
						},
						orderBy: (table, { asc }) => [asc(table.id)],
					},
				},
			},
			assignedTasks: {
				columns: { id: true, title: true, status: true, priority: true },
				orderBy: (table, { asc }) => [asc(table.id)],
				with: {
					project: {
						columns: { id: true, title: true },
					},
				},
			},
		},
	})

	const taskCount = await db.$count(tasks)
	const rawValues = await db.values(sql`SELECT id, name FROM ${users} ORDER BY id`)

	await db.transaction(
		async (tx) => {
			await tx
				.insert(tasks)
				.values({
					id: 102,
					projectId: 10,
					assigneeId: 1,
					title: 'Commit transaction',
					status: 'done',
					priority: 'low',
					estimateHours: 1,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.execute()
		},
		{
			accessMode: 'read write',
			isolationLevel: 'serializableReadWrite',
			idempotent: true,
		}
	)

	console.log('Connection:', connectionString)
	console.log('Joined rows:', joinedRows)
	console.log('Project dashboard:', JSON.stringify(projectDashboard, null, 2))
	console.log('Review task:', JSON.stringify(reviewTask, null, 2))
	console.log('User workloads:', JSON.stringify(userWorkloads, null, 2))
	console.log('Task count before transaction insert:', Number(taskCount))
	console.log('Raw values:', rawValues)
	console.log('Final task count:', Number(await db.$count(tasks)))
} catch (error) {
	console.error('Drizzle adapter example failed:', error)
	process.exitCode = 1
} finally {
	await db.$client.close?.()
}
