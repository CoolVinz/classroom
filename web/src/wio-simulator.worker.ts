import type { WioLabId } from "../../src/wio-labs";
import { checkSketch, createBoard, type BoardInput, type BoardSnapshot } from "./wio-board";

export type SimulatorRequest =
  | { type: "start"; source: string; inputs: BoardInput }
  | { type: "check"; source: string; lab: WioLabId }
  | { type: "tick"; inputs: BoardInput };
export type SimulatorResponse =
  | { type: "board"; board?: BoardSnapshot }
  | { type: "result"; passed: boolean; message: string }
  | { type: "error"; message: string };

let board: ReturnType<typeof createBoard> | undefined;
let revision = -1;
function send(message: SimulatorResponse) {
  self.postMessage(message);
}

self.onmessage = ({ data }: MessageEvent<SimulatorRequest>) => {
  try {
    if (data.type === "check") {
      send({ type: "result", ...checkSketch(data.lab, data.source) });
    } else if (data.type === "start") {
      board = createBoard(data.source);
      board.advance(0, data.inputs);
      revision = board.revision();
      send({ type: "board", board: board.snapshot() });
    } else if (board) {
      board.advance(25, data.inputs);
      const changed = board.revision() !== revision;
      revision = board.revision();
      send({ type: "board", board: changed ? board.snapshot() : undefined });
    }
  } catch (error) {
    board = undefined;
    send({ type: "error", message: error instanceof Error ? error.message : "ตัวจำลองหยุดทำงาน" });
  }
};
