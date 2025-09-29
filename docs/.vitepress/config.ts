import { defineConfig } from 'vitepress'

const base = process.env.DOCS_BASE || '/'
const sitemapHostname = process.env.SITE_HOSTNAME || 'https://ydb-platform.github.io/ydb-js-sdk'

// https://vitepress.dev/reference/site-config
export default defineConfig({
	base,
	cleanUrls: true,
	sitemap: { hostname: sitemapHostname },
	locales: {
		root: {
			label: 'English',
			lang: 'en-US',
			title: 'YDB JS SDK',
			description: 'YDB JavaScript/TypeScript Documentation',
			themeConfig: {
				lastUpdated: true,
				nav: [
					{ text: 'Getting Started', link: '/guide/core' },
					{ text: 'Query', link: '/guide/query/' },
					{ text: 'Topic', link: '/guide/topic/' },
					{ text: 'Advanced', link: '/advanced/' }
				],
            sidebar: [
                {
                    text: 'Getting Started',
                    items: [ { text: 'Getting Started', link: '/guide/core' } ]
                },
                {
                    text: 'Query',
                    items: [
                        { text: 'Overview', link: '/guide/query/' },
                        { text: 'Options & API', link: '/guide/query/options' },
                        { text: 'Types & Values', link: '/guide/query/value' },
                        { text: 'Transactions', link: '/guide/query/transactions' },
                        { text: 'Security', link: '/guide/query/security' },
                        {
                          text: 'Examples',
                          items: [
                            { text: 'Parameters & AS_TABLE', link: '/guide/query/#examples-parameters' },
                            { text: 'Named parameters', link: '/guide/query/#examples-named-parameters' },
                            { text: 'Collecting stats', link: '/guide/query/#examples-stats' },
                            { text: 'Result formats', link: '/guide/query/#examples-results' },
                            { text: 'Per-call isolation', link: '/guide/query/#examples-isolation' },
                            { text: 'Error handling', link: '/guide/query/#examples-errors' },
                            { text: 'Identifiers & unsafe', link: '/guide/query/#examples-identifiers' },
                            { text: 'Events & retries', link: '/guide/query/#examples-events' },
                            { text: 'Cancellation & timeouts', link: '/guide/query/#examples-cancel' },
                            { text: 'Isolation modes', link: '/guide/query/#examples-isolation-modes' },
                            { text: 'Syntax & pool', link: '/guide/query/#examples-syntax-pool' },
                          ]
                        }
                    ]
                },
                {
                    text: 'Topic',
                    items: [
                        { text: 'Overview', link: '/guide/topic/' },
                        { text: 'Options', link: '/guide/topic/options' },
                        { text: 'Semantics', link: '/guide/topic/semantics' },
                        { text: 'Transactions', link: '/guide/topic/transactions' },
                        {
                          text: 'Examples',
                          items: [
                            { text: 'Reader batching', link: '/guide/topic/#examples-reader-batching' },
                            { text: 'Custom codecs', link: '/guide/topic/#examples-codecs' },
                            { text: 'Transactional reader/writer', link: '/guide/topic/#examples-tx' },
                            { text: 'Writer acks & seqNo', link: '/guide/topic/#examples-acks' },
                            { text: 'Payload/inflight limits', link: '/guide/topic/#examples-limits' },
                            { text: 'Graceful shutdown', link: '/guide/topic/#examples-shutdown' },
                            { text: 'Multiple sources', link: '/guide/topic/#examples-sources' },
                            { text: 'Time selectors', link: '/guide/topic/#examples-time-selectors' },
                            { text: 'Partition hooks', link: '/guide/topic/#examples-hooks' },
                          ]
                        }
                    ]
                },
                {
                    text: 'Advanced',
                    items: [
                        { text: 'Retries & Idempotency', link: '/advanced/retries' },
                        { text: 'Error Handling', link: '/advanced/errors' },
                        { text: 'Debug Logging', link: '/advanced/debug' },
                        { text: 'Low-level clients (driver)', link: '/advanced/driver-low-level' }
                    ]
                }
            ],
				socialLinks: [ { icon: 'github', link: 'https://github.com/ydb-platform/ydb-js-sdk' } ]
			}
		},
		ru: {
			label: 'Русский',
			lang: 'ru-RU',
			link: '/ru/',
			title: 'YDB JS SDK',
			description: 'Документация по YDB JS SDK',
			themeConfig: {
				lastUpdated: true,
				nav: [
      { text: 'Начало работы', link: '/ru/guide/core' },
					{ text: 'Query', link: '/ru/guide/query/' },
					{ text: 'Topic', link: '/ru/guide/topic/' },
					{ text: 'Расширенные темы', link: '/ru/advanced/' }
				],
				sidebar: [
          { text: 'Начало работы', items: [ { text: 'Начало работы', link: '/ru/guide/core' } ] },
                	{ text: 'Query', items: [
                		{ text: 'Обзор', link: '/ru/guide/query/' },
                		{ text: 'Опции и API', link: '/ru/guide/query/options' },
                		{ text: 'Типы и значения', link: '/ru/guide/query/value' },
                		{ text: 'Транзакции', link: '/ru/guide/query/transactions' },
                		{ text: 'Безопасность', link: '/ru/guide/query/security' },
                        {
                          text: 'Примеры',
                          items: [
                            { text: 'Параметры и AS_TABLE', link: '/ru/guide/query/#examples-parameters' },
                            { text: 'Именованные параметры', link: '/ru/guide/query/#examples-named-parameters' },
                            { text: 'Получение статистики', link: '/ru/guide/query/#examples-stats' },
                            { text: 'Форматы результата', link: '/ru/guide/query/#examples-results' },
                            { text: 'Изоляция одиночного вызова', link: '/ru/guide/query/#examples-isolation' },
                            { text: 'Обработка ошибок', link: '/ru/guide/query/#examples-errors' },
                            { text: 'Идентификаторы и unsafe', link: '/ru/guide/query/#examples-identifiers' },
                            { text: 'События и ретраи', link: '/ru/guide/query/#examples-events' },
                            { text: 'Отмена и таймауты', link: '/ru/guide/query/#examples-cancel' },
                            { text: 'Режимы изоляции', link: '/ru/guide/query/#examples-isolation-modes' },
                            { text: 'Syntax и pool', link: '/ru/guide/query/#examples-syntax-pool' },
                          ]
                        }
                	] },
                	{ text: 'Topic', items: [
                		{ text: 'Обзор', link: '/ru/guide/topic/' },
                		{ text: 'Опции', link: '/ru/guide/topic/options' },
                		{ text: 'Семантика', link: '/ru/guide/topic/semantics' },
                		{ text: 'Транзакции', link: '/ru/guide/topic/transactions' },
                        {
                          text: 'Примеры',
                          items: [
                            { text: 'Reader: батчи', link: '/ru/guide/topic/#examples-reader-batching' },
                            { text: 'Кастомные кодеки', link: '/ru/guide/topic/#examples-codecs' },
                            { text: 'Транзакционные клиенты', link: '/ru/guide/topic/#examples-tx' },
                            { text: 'Подтверждения и seqNo', link: '/ru/guide/topic/#examples-acks' },
                            { text: 'Лимиты payload/inflight', link: '/ru/guide/topic/#examples-limits' },
                            { text: 'Корректное завершение', link: '/ru/guide/topic/#examples-shutdown' },
                            { text: 'Несколько источников', link: '/ru/guide/topic/#examples-sources' },
                            { text: 'readFrom и maxLag', link: '/ru/guide/topic/#examples-time-selectors' },
                            { text: 'Хуки партиций', link: '/ru/guide/topic/#examples-hooks' },
                          ]
                        }
                	] },
					{ text: 'Расширенные темы', items: [
						{ text: 'Повторные попытки и идемпотентность', link: '/ru/advanced/retries' },
						{ text: 'Обработка ошибок', link: '/ru/advanced/errors' },
						{ text: 'Debug‑логирование', link: '/ru/advanced/debug' },
						{ text: 'Низкоуровневые клиенты (driver)', link: '/ru/advanced/driver-low-level' }
					] }
				],
			}
		}
	}
})
