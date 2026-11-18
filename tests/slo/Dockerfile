# node, oven/bun
ARG image="node:26.13.1"

FROM ${image}
WORKDIR /usr/src/app

COPY package.json dist/ ./

ENTRYPOINT ["node", "index.js"]
CMD [ \
	"--setup=kv.setup", "--kv.setup.prefill=1000", \
	"--teardown=kv.teardown", \
	"--worker=kv.read", "--kv.read.rps=1000", "--kv.read.keyspace=1000", \
	"--worker=kv.write", "--kv.write.rps=100", "--kv.write.keyspace=1000" \
]
