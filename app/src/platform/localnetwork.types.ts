// The local network port (AD-34, goal 4.7): what the phone says of its permission to reach the local network, and the way to the system's
// settings when it was refused. iOS asks at the first connection to a device on the network; Android has no such permission.
export type LocalNetworkState = "granted" | "denied" | "unknown";

export type LocalNetwork = {
  /** The permission now; "unknown" before the system was asked (iOS) and wherever there is none to read. */
  state(): Promise<LocalNetworkState>;
  /** Whether the system has settings this app can open (a phone: yes; the web build: no). */
  canOpenSettings: boolean;
  /** Opens this app's page in the system's settings. Rejects when the system refuses. */
  openSettings(): Promise<void>;
};
