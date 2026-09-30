import * as React from "react";
import { IconProps } from "./types";

function Plus({ color = "white", ...props }: IconProps) {
  return (
    <svg
      width="49"
      height="48"
      viewBox="0 0 49 48"
      stroke={color}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M24.5 10V38M10.5 24H38.5" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MemoPlus = React.memo(Plus);
export default MemoPlus;
