import * as React from "react";
import { IconProps } from "./types";

function Robot(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/* Antenna */}
      <line x1="12" y1="1" x2="12" y2="3" />
      <circle cx="12" cy="1" r="0.8" />

      {/* Head */}
      <rect x="6" y="3" width="12" height="8" rx="2" ry="2" />

      {/* Eyes */}
      <circle cx="9" cy="6.5" r="0.8" fill="white" />
      <circle cx="15" cy="6.5" r="0.8" fill="white" />

      {/* Mouth */}
      <line x1="10" y1="9" x2="14" y2="9" strokeWidth="1.5" />

      {/* Body */}
      <rect x="7" y="13" width="10" height="8" rx="2" ry="2" />

      {/* Arms/Handles */}
      <path d="M6 15 C4 15, 3 16, 3 17.5 C3 19, 4 20, 6 20" />
      <path d="M18 15 C20 15, 21 16, 21 17.5 C21 19, 20 20, 18 20" />

      {/* Neck connection */}
      <line x1="10" y1="11" x2="10" y2="13" />
      <line x1="14" y1="11" x2="14" y2="13" />
    </svg>
  );
}

const MemoRobot = React.memo(Robot);
export default MemoRobot;
