import * as React from "react";
import { IconProps } from "./types";

function AddNote(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M10.6667 1.33334V2.66668M7.33333 1.33334V2.66668M4 1.33334V2.66668"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.9998 6.66667C12.9998 4.46678 12.9998 3.36683 12.3164 2.68342C11.633 2 10.5331 2 8.33317 2H6.33317C4.13328 2 3.03334 2 2.34992 2.68342C1.6665 3.36683 1.6665 4.46678 1.6665 6.66667V10C1.6665 12.1999 1.6665 13.2998 2.34992 13.9833C3.03334 14.6667 4.13328 14.6667 6.33317 14.6667H8.33317"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.6667 9.33334L11.6667 14.6667M14.3333 12L9 12"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M4.6665 9.99999H7.33317M4.6665 6.66666H9.99984" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const MemoAddNote = React.memo(AddNote);
export default MemoAddNote;
