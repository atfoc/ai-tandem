import { NativeModule, requireNativeModule } from 'expo';

import type {
  AiwbNetModuleEvents, MemoryInfo, OpenedSession, RawResponse, RequestOptions, StreamHead, StreamOptions,
} from './AiwbNet.types';

declare class AiwbNetModule extends NativeModule<AiwbNetModuleEvents> {
  readCertificate(host: string, port: number, dialMs: number, handshakeMs: number): Promise<string>;
  openSession(host: string, port: number, pin: string, dialMs: number, handshakeMs: number, preflight: boolean): Promise<OpenedSession>;
  request(opts: RequestOptions): Promise<RawResponse>;
  startStream(opts: StreamOptions): Promise<StreamHead>;
  cancel(id: string): void;
  closeSession(id: string): void;
  sessionStats(id: string): { connects: number; open: number };
  echoBytes(data: Uint8Array): Uint8Array;
  memory(): MemoryInfo;
  log(line: string): void;
}

export default requireNativeModule<AiwbNetModule>('AiwbNet');
