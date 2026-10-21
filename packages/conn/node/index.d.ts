// The types of @aiwb/conn/node: the Client with the Node ports (the desktop app's main process and the test host).

import type { Client, ClientOptions, Connector, Store, Timing } from '../index';
import type { NodeLocalOptions } from './local';
import type { Socket } from 'node:net';

export type { NodeLocalOptions } from './local';
export { nodeLocal } from './local';

export type NodeClientOptions = {
  /** Holds servers.json and client-id; made 0700 when missing. */
  stateDir: string;
  /** null (a host of remote servers only) or this computer's server program. */
  local?: NodeLocalOptions | null;
  timing?: Partial<Timing>;
  /** Never given a secret. */
  log?: (line: string) => void;
  /** Test seam: replaces net.connect. */
  dial?: (o: { host: string; port: number; family: 4 }) => Socket;
  /** Test seam: PEM roots a certificate without the self-signed box is verified against. */
  roots?: string | Buffer | Array<string | Buffer>;
};

/** Today's createClient: the shared Client with nodeConnector, fileStore(stateDir) and nodeLocal(local). */
export function createNodeClient(options: NodeClientOptions): Client;

export function parseAppWaits(value: string | undefined | null): Partial<Timing>;

/** The Connector over node:tls and node:http2. */
export function nodeConnector(o?: { dial?: NodeClientOptions['dial']; roots?: NodeClientOptions['roots'] }): Connector;

/** The Store over <stateDir>/servers.json and <stateDir>/client-id. now: the clock of the set-aside name. */
export function fileStore(stateDir: string, o?: { now?: () => Date }): Store;

/** Writes the file next to `file` and renames it over `file`, with the mode (the desktop's voice key file uses it). */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode: number): void;

/** Makes the folder, mode 0700, when it is missing. */
export function ensureStateDir(root: string): void;

export type { ClientOptions };
