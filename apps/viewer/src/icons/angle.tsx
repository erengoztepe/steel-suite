import * as React from "react";
import { IconProps } from "./types";

function Angle(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      {/* two rays meeting at the bottom-left vertex, with a small arc marking the angle between them */}
      <path
        d="M2.5 13.5H13.5M2.5 13.5L11.5 3.5"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 13.5C9 11.7 8.1 9.9 6.7 8.6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const MemoAngle = React.memo(Angle);
export default MemoAngle;
