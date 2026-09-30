import * as React from "react";
import { IconProps } from "./types";

function ConstructionAnimation(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect x="2" y="14" width="16" height="2" rx="0.5" stroke="white" strokeWidth="1.2" />
      <rect x="4" y="10" width="4" height="4" stroke="white" strokeWidth="1.2" />
      <rect x="12" y="10" width="4" height="4" stroke="white" strokeWidth="1.2" />
      <rect x="6" y="6" width="8" height="4" stroke="white" strokeWidth="1.2" />
      <path d="M2 18H18" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M10 2V4" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M7 3L10 2L13 3" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MemoConstructionAnimation = React.memo(ConstructionAnimation);
export default MemoConstructionAnimation;
