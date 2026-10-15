import { NativeModule, requireNativeModule } from 'expo';

import type { AiwbNetModuleEvents, Answer, CallOptions, Head } from './AiwbNet.types';

declare class AiwbNetModule extends NativeModule<AiwbNetModuleEvents> {
  env: Record<string, string>;
  readCertificate(host: string, port: number, timeoutMs: number): Promise<string>;
  openSession(host: string, port: number, pin: string): Promise<string>;
  request(sessionId: string, requestId: string, options: CallOptions): Promise<Answer>;
  stream(sessionId: string, requestId: string, options: CallOptions): Promise<Head>;
  cancel(sessionId: string, requestId: string): void;
  closeSession(sessionId: string): void;
  normalFingerprint(s: string): string | null;
  log(line: string): void;
  selfTestUtf8(text: string): string;
}

export default requireNativeModule<AiwbNetModule>('AiwbNet');
