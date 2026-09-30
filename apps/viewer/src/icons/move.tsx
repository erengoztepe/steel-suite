import * as React from "react";
import { IconProps } from "./types";

function Move(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M10 2.5V7.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 10H7.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17.5 10H12.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 17.5002V12.0835" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M7.5 5L8.92083 3.37354C9.42955 2.79118 9.68392 2.5 10 2.5C10.3161 2.5 10.5704 2.79118 11.0792 3.37354L12.5 5"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.5 15L11.0792 16.6265C10.5704 17.2088 10.3161 17.5 10 17.5C9.68392 17.5 9.42955 17.2088 8.92082 16.6265L7.5 15"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 7.5L16.6265 8.92083C17.2088 9.42955 17.5 9.68392 17.5 10C17.5 10.3161 17.2088 10.5704 16.6265 11.0792L15 12.5"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 12.5L3.37354 11.0792C2.79118 10.5704 2.5 10.3161 2.5 10C2.5 9.68392 2.79118 9.42955 3.37354 8.92082L5 7.5"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoMove = React.memo(Move);
export default MemoMove;
