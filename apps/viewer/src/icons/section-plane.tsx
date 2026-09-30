import * as React from "react";
import { IconProps } from "./types";

function SectionPlane(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      {/* a box with a cutting plane slicing through it — the plane is the filled parallelogram */}
      <path
        d="M3 5.5L8 3L13 5.5V10.5L8 13L3 10.5V5.5Z"
        stroke="white"
        strokeWidth="1.2"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <path
        d="M1.5 8.5L8 5.5L14.5 8.5L8 11.5L1.5 8.5Z"
        stroke="white"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="white"
        fillOpacity="0.18"
      />
    </svg>
  );
}

const MemoSectionPlane = React.memo(SectionPlane);
export default MemoSectionPlane;
