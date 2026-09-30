import * as React from "react";
import { IconProps } from "./types";

function ChevronDown(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" {...props}>
      <path d="M4 6l4 4 4-4" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MemoChevronDown = React.memo(ChevronDown);
export default MemoChevronDown;
