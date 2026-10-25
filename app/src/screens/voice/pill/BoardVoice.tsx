// `BoardVoice` (V1): the phone's voice card over the board, else today's pill; the wide layouts keep the pill exactly.
import { usePhone } from "../../../ui/useLayout.ts";
import { Pill } from "./Pill.tsx";
import { VoiceCard } from "./VoiceCard.tsx";

export function BoardVoice({ board }: { board: string }) {
  return usePhone() ? <VoiceCard board={board} /> : <Pill board={board} />;
}
