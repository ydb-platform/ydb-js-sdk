#!/bin/bash
set -e

source /usr/local/share/nvm/nvm.sh && nvm use --lts

if git config --get commit.gpgsign | grep -q true; then
	git config --global gpg.format ssh
	git config --global gpg.ssh.defaultKeyCommand 'ssh-add -L'
	git config --global gpg.ssh.allowedSigners '~/.ssh/allowed_signers'
fi

# Set up YDB profile if ydb cli exists
if which ydb > /dev/null 2>&1; then
	ENDPOINT=$(echo ${YDB_CONNECTION_STRING_SECURE:-$YDB_CONNECTION_STRING} | awk -F/ '{print $1 "//" $3}')
	DATABASE=$(echo ${YDB_CONNECTION_STRING_SECURE:-$YDB_CONNECTION_STRING} | cut -d/ -f4-)
	CA_FILE_OPTION=""

	if [ -n "$YDB_SSL_ROOT_CERTIFICATES_FILE" ]; then
		ENDPOINT="${ENDPOINT/grpc:/grpcs:}"
		CA_FILE_OPTION="--ca-file ${YDB_SSL_ROOT_CERTIFICATES_FILE}"
	fi

	ydb config profile replace local \
		--endpoint "$ENDPOINT" \
		--database "/$DATABASE" \
		$CA_FILE_OPTION

	ydb config profile activate local
fi
