// Read aloud (VC-24): `useReadAloud`, registered here with `setChatPart`. The mic mark's `MessageMark` is registered by composer.ts.
import { setChatPart } from "../chat/index.ts";
import { useReadAloud } from "./ReadAloud.tsx";

setChatPart("useReadAloud", useReadAloud);
