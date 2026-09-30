import * as React from "react";
import { IconProps } from "./types";

function ThreeDot(props: IconProps) {
  return (
    <svg width="4" height="14" viewBox="0 0 4 14" fill="none" {...props}>
      <path d="M1.99325 7H2.00073" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.9869 12H1.99438" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.99984 2H2.00732" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MemoThreeDot = React.memo(ThreeDot);
export default MemoThreeDot;
