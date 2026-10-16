import type { Providers, ServiceOptions, Request, SyncOperation, Response, ExternalRequest, Receipt, Run } from '../../dist/types.js';
export type * from '../../dist/types.js';
export declare function createRuntimeService(options: ServiceOptions, trustedProviders?: Providers): Readonly<{
    capabilities: () => {
        product: string;
        version: string;
        stage: string;
        operations: string[];
        asyncOperations: string[];
        authority: boolean;
        softwareRelease: boolean;
        limits: Readonly<{
            requestBytes: 524288;
            nodes: 20000;
            depth: 48;
            projects: 1000;
            goals: 1000;
            runs: 1000;
            receipts: 10000;
            stateBytes: 8388608;
            receiptBytes: 33554432;
        }>;
    };
    initialize: () => {
        workspaceId: string;
        initialized: boolean;
        authority: boolean;
    };
    execute: <K extends SyncOperation>(request: Request<K>) => Response<K>;
    dispatch: (args: ExternalRequest) => Promise<Receipt<Run>>;
    reconcile: (args: ExternalRequest) => Promise<Receipt<Run>>;
    close: () => void;
}>;
