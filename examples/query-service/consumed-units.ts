process.env.YDB_SDK_PRETTY_LOGS = '1';

import { Driver, getCredentialsFromEnv, Logger } from 'ydb-sdk';
import { main } from '../utils';

async function run(logger: Logger, endpoint: string, database: string) {
    const authService = getCredentialsFromEnv();
    logger.info('Driver initializing...');
    const driver = new Driver({ endpoint, database, authService });
    const timeout = 10000;
    if (!await driver.ready(timeout)) {
        logger.fatal(`Driver has not become ready in ${timeout}ms!`);
        process.exit(1);
    }

    await driver.queryClient.do({
        fn: async (session) => {
            const res = await session.execute({ text: `SELECT 1;`, });

            // Always drain the result to avoid session stuck
            for await (const resultSet of res.resultSets) {
                for await (const _ of resultSet.rows) {
                }
            }
        },
        onTrailer: (trailer) => {
            let consumedUnits = trailer.get('x-ydb-consumed-units')
            if (consumedUnits) {
                console.info(`Consumed units: ${consumedUnits}`);
            }
        }
    });

    await driver.destroy();
}

main(run);
