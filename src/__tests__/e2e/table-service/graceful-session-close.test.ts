import http from 'http';
import Driver from "../../../driver";

import {sleep} from "../../../utils";
import {initDriver, destroyDriver} from "../../../utils/test";

const SHUTDOWN_URL = process.env.YDB_SHUTDOWN_URL || 'http://localhost:8765/actors/kqp_proxy?force_shutdown=all';

if (process.env.TEST_ENVIRONMENT === 'dev') require('dotenv').config();

describe('Graceful session close', () => {

    // TODO: Fix and enable test nce issue  will be resolved https://github.com/ydb-platform/ydb/issues/2981
    // TODO: Make the same test for query service

    let driver: Driver;
    afterAll(async () => await destroyDriver(driver));

    xit('All sessions should be closed from the server side and be deleted upon return to the pool', async () => {
        const PREALLOCATED_SESSIONS = 10;
        driver = await initDriver({poolSettings: {
            maxLimit: PREALLOCATED_SESSIONS,
            minLimit: PREALLOCATED_SESSIONS
        }});
        // give time for the asynchronous session creation to finish before shutting down all existing sessions
        await sleep(100)
        await http.get(SHUTDOWN_URL); // TODO: !!! Seems was broken
        let sessionsToClose = 0;
        const promises = [];
        for (let i = 0; i < 200; i++) {
            const promise = driver.tableClient.withSessionRetry(async (session) => {
                await session.executeQuery('SELECT Random(1);');

                if (session.isClosing()) {
                    sessionsToClose++;
                }
            });
            promises.push(promise);
        }
        await Promise.all(promises);
        expect(sessionsToClose).toBeGreaterThanOrEqual(PREALLOCATED_SESSIONS);
    });

});
