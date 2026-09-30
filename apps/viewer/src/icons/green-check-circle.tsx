import * as React from "react";
import { IconProps } from "./types";

function GreenCheckCircle(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 16 17" fill="none" {...props}>
      <path
        d="M8 1.33301C11.958 1.33301 15.167 4.54196 15.167 8.5C15.167 12.458 11.958 15.667 8 15.667C4.04196 15.667 0.833008 12.458 0.833008 8.5C0.833008 4.54196 4.04196 1.33301 8 1.33301ZM11.1172 6.00879C10.8458 5.75999 10.4236 5.77839 10.1748 6.0498L6.97949 9.53613L5.80469 8.3623C5.54434 8.10196 5.12265 8.10196 4.8623 8.3623C4.60196 8.62265 4.60196 9.04434 4.8623 9.30469L6.52832 10.9717C6.6569 11.1003 6.83286 11.1709 7.01465 11.167C7.19638 11.163 7.36838 11.0842 7.49121 10.9502L11.1582 6.9502C11.4068 6.67882 11.3884 6.25754 11.1172 6.00879Z"
        fill="#22C55E"
      />
    </svg>
  );
}

const MemoGreenCheckCircle = React.memo(GreenCheckCircle);
export default MemoGreenCheckCircle;
