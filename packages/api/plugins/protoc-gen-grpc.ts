import {
	type Schema,
	createEcmaScriptPlugin,
	runNodeJs,
	safeIdentifier,
} from '@bufbuild/protoplugin'

let plugin = createEcmaScriptPlugin({
	name: 'protoc-gen-grpc',
	version: 'v1',

	generateTs(schema: Schema) {
		for (let file of schema.files) {
			let f = schema.generateFile(file.name + '_grpc_pb.ts')
			f.preamble(file)

			let serviceDefinition = f.import('ServiceDefinition', '@ydbjs/grpc', true)
			let bufProtoCreate = f.import('create', '@bufbuild/protobuf')
			let bufProtoMessageInitShape = f.import('MessageInitShape', '@bufbuild/protobuf', true)
			let bufProtoToBinary = f.import('toBinary', '@bufbuild/protobuf')
			let bufProtoFromBinary = f.import('fromBinary', '@bufbuild/protobuf')

			for (let service of file.services) {
				f.print(f.jsDoc(service))
				f.print(f.export('const', safeIdentifier(service.name + 'Definition')), ' = {')
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
					f.print('    path: ', f.string(`/${service.typeName}/${method.name}`), ',')
					f.print('    requestStream: ' + (requestStream ? 'true' : 'false') + ',')
					f.print(
						'    requestSerialize: (message: ',
						bufProtoMessageInitShape,
						'<typeof ',
						requestSchema,
						'>) =>'
					)
					f.print(
						'      ',
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
						', bytes),'
					)
					f.print('    responseStream: ' + (responseStream ? 'true' : 'false') + ',')
					f.print(
						'    responseSerialize: (message: ',
						bufProtoMessageInitShape,
						'<typeof ',
						responseSchema,
						'>) =>'
					)
					f.print(
						'      ',
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
						', bytes),'
					)
					f.print('  },')
				}
				f.print('} as const satisfies ', serviceDefinition)
			}
		}
	},
})

runNodeJs(plugin)
