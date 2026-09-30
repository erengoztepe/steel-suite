import * as React from "react";
import { IconProps } from "./types";

function Camera(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      {/* camera body with the raised shutter housing, plus the lens */}
      <path
        d="M2 5.5H5L6.2 3.8H9.8L11 5.5H14V12.2H2V5.5Z"
        stroke="white"
        strokeWidth="1.2"
        strokeLinejoin="round"
        opacity="0.75"
      />
      <circle cx="8" cy="8.9" r="2.4" stroke="white" strokeWidth="1.4" fill="white" fillOpacity="0.18" />
    </svg>
  );
}

const MemoCamera = React.memo(Camera);
export default MemoCamera;
