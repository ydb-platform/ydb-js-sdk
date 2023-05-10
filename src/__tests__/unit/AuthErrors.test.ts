
import { FallbackLogger, setupLogger } from '../../logging';
setupLogger(new FallbackLogger({level: 'error'}))

import { ServiceError } from '@grpc/grpc-js/build/src/call';
import {IamAuthService, StaticCredentialsAuthService} from '../../credentials';
import { TransportUnavailable } from '../../errors';
import { StatusObject } from '@grpc/grpc-js';
import { Status } from '@grpc/grpc-js/build/src/constants';

describe('Retries on errors in auth services', () => {
    const mockIamCounter = {retries: 0}
    const mockStaticCredCounter = {retries: 0}
    function mockCallErrorFromStatus(status: StatusObject): ServiceError {
        const message = `${status.code} ${Status[status.code]}: ${status.details}`;
        return Object.assign(new Error(message), status);
      }

    beforeEach(() => {});
    beforeAll(() => {

        jest.mock('ydb-sdk-proto', () => {
            const actual = jest.requireActual('ydb-sdk-proto') as typeof import('ydb-sdk-proto')

            actual.yandex.cloud.iam.v1.IamTokenService.create = function test_create(rpcImpl, requestDelimited, responseDelimited) {
                const service = new this(rpcImpl, requestDelimited, responseDelimited);
                service.create = (function myCustomCreate() {
                    mockIamCounter.retries++
                    // @ts-ignore
                    throw mockCallErrorFromStatus({code: 14, details: 'My custom unavailable error', metadata: {}})
                })
                return service
            };

            actual.Ydb.Auth.V1.AuthService.create = function test_create(rpcImpl, requestDelimited, responseDelimited) {
                const service = new this(rpcImpl, requestDelimited, responseDelimited);
                service.login = (function myCustomLogin() {
                    mockStaticCredCounter.retries++
                    // @ts-ignore
                    throw mockCallErrorFromStatus({code: 14, details: 'My custom unavailable error', metadata: {}})
                })
                return service
            } 
            return actual
        })
        require('ydb-sdk-proto')
    });

    it('IAM auth service - UNAVAILABLE', async () => {
        const iamAuth = new IamAuthService({
            accessKeyId: '1',
            iamEndpoint: '2',
            privateKey: Buffer.from('3'),
            serviceAccountId: '4',
        });
        // mock jwt request return
        iamAuth['getJwtRequest'] = () => '';

        await expect(async () => {
            await iamAuth.getAuthMetadata()
        }).rejects.toThrow(TransportUnavailable);
        await expect(mockIamCounter.retries).toBe(10);
    });

    it('Static creds auth service - UNAVAILABLE', async () => {
        const staticAuth = new StaticCredentialsAuthService('usr', 'pwd', 'endpoint');

        await expect(async () => {
            await staticAuth.getAuthMetadata()
        }).rejects.toThrow(TransportUnavailable);
        await expect(mockStaticCredCounter.retries).toBe(10);
    });
});
