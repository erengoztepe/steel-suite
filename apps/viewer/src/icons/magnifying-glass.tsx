import * as React from "react";
import { IconProps } from "./types";

function MagnifyingGlass(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props} >
      <path d="M11.667 11.667L14.667 14.667" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.333 7.33301C13.333 4.0193 10.6467 1.33301 7.33301 1.33301C4.0193 1.33301 1.33301 4.0193 1.33301 7.33301C1.33301 10.6467 4.0193 13.333 7.33301 13.333C10.6467 13.333 13.333 10.6467 13.333 7.33301Z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

const MemoMagnifyingGlass = React.memo(MagnifyingGlass);
export default MemoMagnifyingGlass;
