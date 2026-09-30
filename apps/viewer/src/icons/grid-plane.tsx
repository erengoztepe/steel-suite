import * as React from "react";
import { IconProps } from "./types";

function GridPlane(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      {/* a ground plane seen in perspective: a parallelogram ruled by two grid lines each way */}
      <path
        d="M6 3.5H14L10 12.5H2L6 3.5Z"
        stroke="white"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M8.67 3.5L4.67 12.5M11.33 3.5L7.33 12.5M4.67 6.5H12.44M3.33 9.5H11.11"
        stroke="white"
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}

const MemoGridPlane = React.memo(GridPlane);
export default MemoGridPlane;
