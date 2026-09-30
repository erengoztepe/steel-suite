import * as React from "react";
import { IconProps } from "./types";

function Magnet(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      {/* horseshoe magnet: a U-shaped body with the two pole caps banded at the tips */}
      <path
        d="M4.5 2.75V8.5a3.5 3.5 0 0 0 7 0V2.75"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4.5 6H8M9 6h2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const MemoMagnet = React.memo(Magnet);
export default MemoMagnet;
