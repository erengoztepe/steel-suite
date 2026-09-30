import * as React from "react";
import { IconProps } from "./types";

function Flip(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      {/* a plane (the dashed mid-line) with arrows pointing to either side — flip which half is kept */}
      <path d="M2 8H14" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="2 1.6" />
      <path
        d="M8 2V5.5M8 2L6.4 3.6M8 2L9.6 3.6"
        stroke="white"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 14V10.5M8 14L6.4 12.4M8 14L9.6 12.4"
        stroke="white"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoFlip = React.memo(Flip);
export default MemoFlip;
