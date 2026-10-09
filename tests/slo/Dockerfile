# node, oven/bun
ARG image="node"

FROM ${image}
ARG runtime="node"
ENV SLO_RUNTIME=${runtime} TOPIC_RESULT_FILE=/tmp/topic-result.json
WORKDIR /usr/src/app

COPY package.json dist/ ./

ENTRYPOINT ["/bin/sh", "-c", "exec \"$SLO_RUNTIME\" index.js \"$@\"", "--"]
CMD [ \
	"--setup=kv.setup", "--kv.setup.prefill=1000", \
	"--teardown=kv.teardown", \
	"--worker=kv.read", "--kv.read.rps=1000", "--kv.read.keyspace=1000", \
	"--worker=kv.write", "--kv.write.rps=100", "--kv.write.keyspace=1000" \
]
