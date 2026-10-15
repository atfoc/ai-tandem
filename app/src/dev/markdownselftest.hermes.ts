// The entry the Hermes host runs (src/dev/markdownselftest.ts): prints the self-test's lines with the host's `print`.
import { selfTest } from "./markdownselftest.ts";

declare const print: (s: string) => void;
for (const line of selfTest()) print(line);
print("selftest done");
