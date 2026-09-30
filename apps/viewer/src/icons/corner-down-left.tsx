import * as React from "react";
import { IconProps } from "./types";

function CornerDownLeft(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M7.50004 8.33331L3.33337 12.5M3.33337 12.5L7.50004 16.6666M3.33337 12.5H13.3334C14.2174 12.5 15.0653 12.1488 15.6904 11.5237C16.3155 10.8985 16.6667 10.0507 16.6667 9.16665V3.33331"
        stroke="#0E1420"
        strokeWidth="1.33"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoCornerDownLeft = React.memo(CornerDownLeft);
export default MemoCornerDownLeft;
