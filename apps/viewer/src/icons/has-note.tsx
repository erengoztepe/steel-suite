import * as React from "react";
import { IconProps } from "./types";

function HasNote(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M11.3332 1.33334V2.66668M7.99984 1.33334V2.66668M4.6665 1.33334V2.66668"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.3335 6.66667C2.3335 4.46678 2.3335 3.36683 3.01691 2.68342C3.70033 2 4.80028 2 7.00016 2H9.00016C11.2001 2 12.3 2 12.9834 2.68342C13.6668 3.36683 13.6668 4.46678 13.6668 6.66667V10C13.6668 12.1999 13.6668 13.2998 12.9834 13.9833C12.3 14.6667 11.2001 14.6667 9.00016 14.6667H7.00016C4.80027 14.6667 3.70033 14.6667 3.01691 13.9833C2.3335 13.2998 2.3335 12.1999 2.3335 10V6.66667Z"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5.3335 9.99999H8.00016M5.3335 6.66666H10.6668" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="13" cy="13" r="2.5" fill="#DF1C41" stroke="#121721" />
    </svg>
  );
}

const MemoHasNote = React.memo(HasNote);
export default MemoHasNote;
