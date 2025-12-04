import {
	type Schema,
	createEcmaScriptPlugin,
	runNodeJs,
	safeIdentifier,
} from '@bufbuild/protoplugin'

let plugin = createEcmaScriptPlugin({
	name: 'protoc-gen-nice-grpc',
	version: 'v1',

	generateTs(schema: Schema) {
		// Loop through all Protobuf files in the schema
		for (let file of schema.files) {
			let f = schema.generateFile(file.name + '_grpc_pb.ts')
			f.preamble(file)

			let niceGRPCServiceDefinition = f.import(
				'ServiceDefinition',
				'nice-grpc',
				true
			)
			let bufProtoCreate = f.import('create', '@bufbuild/protobuf')
			let bufProtoMessageInitShape = f.import(
				'MessageInitShape',
				'@bufbuild/protobuf',
				true
			)
			let bufProtoToBinary = f.import('toBinary', '@bufbuild/protobuf')
			let bufProtoFromBinary = f.import(
				'fromBinary',
				'@bufbuild/protobuf'
			)

			// Create a service definition based on the Nice-GRPC one
			// (see https://github.com/deeplay-io/nice-grpc/blob/7458e8a57aec763d854c2e6eb119bfe6820b17dd/packages/nice-grpc/src/service-definitions/index.ts#L20)
			for (let service of file.services) {
				f.print(f.jsDoc(service))
				f.print(
					f.export(
						'const',
						safeIdentifier(service.name + 'Definition')
					),
					' = {'
				)
				for (let method of service.methods) {
					let requestSchema = f.importSchema(method.input)
					let responseSchema = f.importSchema(method.output)
					let requestStream =
						method.methodKind === 'client_streaming' ||
						method.methodKind === 'bidi_streaming'
					let responseStream =
						method.methodKind === 'server_streaming' ||
						method.methodKind === 'bidi_streaming'

					f.print(f.jsDoc(method, '  '))
					f.print('  ', safeIdentifier(method.localName), ': {')
					f.print(
						'    path: ',
						f.string(`/${service.typeName}/${method.name}`),
						','
					)
					f.print(
						'    requestStream: ' +
							(requestStream ? 'true' : 'false') +
							','
					)
					f.print(
						'    requestSerialize: (message: ',
						bufProtoMessageInitShape,
						'<typeof ',
						requestSchema,
						'>) => ',
						bufProtoToBinary,
						'(',
						requestSchema,
						', ',
						bufProtoCreate,
						'(',
						requestSchema,
						', message)),'
					)
					f.print(
						'    requestDeserialize: (bytes: Uint8Array) => ',
						bufProtoFromBinary,
						'(',
						requestSchema,
						',bytes),'
					)
					f.print(
						'      responseStream: ' +
							(responseStream ? 'true' : 'false') +
							', '
					)
					f.print(
						'    responseSerialize: (message: ',
						bufProtoMessageInitShape,
						'<typeof ',
						responseSchema,
						'>) => ',
						bufProtoToBinary,
						'(',
						responseSchema,
						', ',
						bufProtoCreate,
						'(',
						responseSchema,
						', message)),'
					)
					f.print(
						'    responseDeserialize: (bytes: Uint8Array) => ',
						bufProtoFromBinary,
						'(',
						responseSchema,
						',bytes),'
					)
					f.print('    options: {},')
					f.print('  },')
				}
				f.print('} as const satisfies ', niceGRPCServiceDefinition)

				f.print('//@ts-expect-error')
				f.print(
					safeIdentifier(service.name + 'Definition'),
					'["name"] = "',
					service.name,
					'";'
				)
				f.print('//@ts-expect-error')
				f.print(
					safeIdentifier(service.name + 'Definition'),
					'["fullName"] = "',
					service.typeName,
					'";'
				)
			}
		}
	},
})

// Reads the schema from stdin, runs the plugin, and writes the generated files to stdout.
runNodeJs(plugin)
